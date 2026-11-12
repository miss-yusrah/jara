import { formatEther } from 'viem'
import { gasStatus, gdBalance } from './chain'
import { spendableWei, spendingPower } from './spend'
import { atomic, run } from './db'
import { withMoneyLock } from './money-lock'
import { moneyRequest } from './money-request'
import { gdForNgn, ngnPerGd } from './price'
import { JAR_INFO, JAR_KINDS, type JarKind, type User } from './users'

// The agent wallet's on-chain G$ balance is the source of truth. Jars are a
// ledger that splits that balance up; whatever isn't in a jar is "free".

export interface JarDetails {
  phone?: string
  network?: string
  planCode?: string
  planName?: string
  disco?: string
  meterType?: string
  meterNumber?: string
  customerName?: string
}

export interface Jar {
  kind: JarKind
  balanceWei: bigint
  targetNgn: number
  autoPay: boolean
  details: JarDetails
  /** How often this bill comes round (e.g. light every 10 days). */
  everyDays: number | null
  lastPaidAt: number | null
}

export interface JarView {
  kind: JarKind
  label: string
  emoji: string
  balanceGd: number
  balanceNgn: number
  targetNgn: number
  pct: number
  autoPay: boolean
  details: JarDetails
  everyDays: number | null
  /** ms timestamp when the bill is next due, if Jara knows the cadence. */
  dueAt: number | null
}

export interface Snapshot {
  jars: JarView[]
  totalGd: number
  freeGd: number
  freeNgn: number
  ngnPerGd: number
  /** G$ in the person's own GoodDollar wallet (not yet in Jara); null if unknown. */
  walletGd: number | null
  /** CELO in the Jara wallet for network fees, and what one transaction costs now; null if unknown. */
  gas: { celo: number; perTxCelo: number } | null
  /** wallet = G$ stays in their wallet under a spending limit; jar = older setup, G$ held by Jara. */
  mode: 'wallet' | 'jar'
  /** G$ Jara claimed and holds, after network fees owed back. */
  claimedGd: number
  /** How much more Jara may take from their wallet (wallet mode). */
  limitLeftGd: number
  /** Network fees Jara paid for them, owed back in G$. */
  feesOwedGd: number
}

// Database-backed lock also covers other workers and survives process restarts.
export const withUserLock = <T>(userId: string, fn: () => Promise<T>): Promise<T> => withMoneyLock(`user:${userId}`, fn)

export async function getJars(userId: string): Promise<Jar[]> {
  let r = await run('SELECT * FROM jars WHERE user_id = ?', [userId])
  if (r.rows.length < JAR_KINDS.length) {
    // Jars added in later versions (e.g. the AI jar) for existing users.
    for (const kind of JAR_KINDS) {
      await run('INSERT OR IGNORE INTO jars (user_id, kind, target_ngn) VALUES (?, ?, ?)', [userId, kind, JAR_INFO[kind].defaultTarget])
    }
    r = await run('SELECT * FROM jars WHERE user_id = ?', [userId])
  }
  const byKind = new Map(r.rows.map((x) => [x.kind as JarKind, x]))
  return JAR_KINDS.map((kind) => {
    const x = byKind.get(kind)
    return {
      kind,
      balanceWei: BigInt((x?.balance_wei as string) ?? '0'),
      targetNgn: Number(x?.target_ngn ?? JAR_INFO[kind].defaultTarget),
      autoPay: Number(x?.auto_pay ?? 0) === 1,
      details: x ? (JSON.parse(x.details as string) as JarDetails) : {},
      everyDays: x?.every_days ? Number(x.every_days) : null,
      lastPaidAt: x?.last_paid_at ? Number(x.last_paid_at) : null,
    }
  })
}

export async function updateJar(
  userId: string,
  kind: JarKind,
  patch: Partial<{ targetNgn: number; autoPay: boolean; details: JarDetails; everyDays: number | null }>,
) {
  return withUserLock(userId, async () => {
    const jar = (await getJars(userId)).find((j) => j.kind === kind)!
    const every = 'everyDays' in patch ? patch.everyDays : jar.everyDays
    await run('UPDATE jars SET target_ngn = ?, auto_pay = ?, details = ?, every_days = ? WHERE user_id = ? AND kind = ?', [
      Math.max(0, Math.round(patch.targetNgn ?? jar.targetNgn)),
      (patch.autoPay ?? jar.autoPay) ? 1 : 0,
      JSON.stringify({ ...jar.details, ...(patch.details ?? {}) }),
      every && every > 0 ? Math.round(every) : null,
      userId,
      kind,
    ])
  })
}

export async function markJarPaid(userId: string, kind: JarKind) {
  await run('UPDATE jars SET last_paid_at = ? WHERE user_id = ? AND kind = ?', [Date.now(), userId, kind])
}

export function jarDueAt(j: Pick<Jar, 'everyDays' | 'lastPaidAt'>): number | null {
  return j.everyDays && j.lastPaidAt ? j.lastPaidAt + j.everyDays * 86_400_000 : null
}

/**
 * Reconcile jars with the on-chain balance. New G$ (claims, deposits) is shared
 * between jars that are below target, in proportion to what each still needs.
 * Returns the amount of new G$ that was allocated.
 */
export async function syncJars(user: User): Promise<bigint> {
  return withUserLock(user.id, async () => {
    const pending = await run("SELECT 1 FROM payments WHERE user_id = ? AND status IN ('reserved', 'refunding') LIMIT 1", [user.id])
    if (pending.rows.length) return 0n
    const balance = await spendableWei(user)
    const jars = await getJars(user.id)
    const allocated = jars.reduce((s, j) => s + j.balanceWei, 0n)

    if (balance < allocated) {
      // Balance dropped outside Jara: shrink jars proportionally so the ledger never exceeds reality.
      await atomic(async (tx) => {
        for (const j of jars) {
          const next = allocated === 0n ? 0n : (j.balanceWei * balance) / allocated
          await tx.execute({ sql: 'UPDATE jars SET balance_wei = ? WHERE user_id = ? AND kind = ?', args: [String(next), user.id, j.kind] })
        }
      })
      return 0n
    }

    const free = balance - allocated
    if (free === 0n) return 0n
    const needs = await Promise.all(
      jars.map(async (j) => {
        const target = await gdForNgn(j.targetNgn)
        return target > j.balanceWei ? target - j.balanceWei : 0n
      }),
    )
    const totalNeed = needs.reduce((s, n) => s + n, 0n)
    if (totalNeed === 0n) return 0n
    const pool = free < totalNeed ? free : totalNeed
    let given = 0n
    await atomic(async (tx) => {
      for (let i = 0; i < jars.length; i++) {
        const share = i === jars.length - 1 ? pool - given : (pool * needs[i]) / totalNeed
        const capped = share > needs[i] ? needs[i] : share
        given += capped
        await tx.execute({ sql: 'UPDATE jars SET balance_wei = ? WHERE user_id = ? AND kind = ?', args: [String(jars[i].balanceWei + capped), user.id, jars[i].kind] })
      }
    })
    return given
  })
}

/** Allocate unassigned G$ to a jar. Other jar budgets are never borrowed automatically. */
export async function moveToJar(user: User, kind: JarKind, ngn: number, requestId?: string): Promise<{ movedGd: number }> {
  return withUserLock(user.id, async () => {
    if (!Number.isFinite(ngn) || ngn <= 0) throw new Error('Enter a positive amount to move.')
    const request = requestId ? await moneyRequest(user.id, `move:${requestId}`, { kind, ngn }) : null
    if (request?.result) return request.result as { movedGd: number }
    if ((await run("SELECT 1 FROM payments WHERE user_id = ? AND status IN ('reserved', 'refunding')", [user.id])).rows.length) throw new Error('Wait for your pending payment or refund before changing budgets.')
    const want = await gdForNgn(ngn)
    const balance = await spendableWei(user)
    const jars = await getJars(user.id)
    const target = jars.find((j) => j.kind === kind)!
    let free = balance - jars.reduce((s, j) => s + j.balanceWei, 0n)
    if (free < 0n) free = 0n
    const moved = want < free ? want : free
    const result = { movedGd: Number(formatEther(moved)) }
    await atomic(async (tx) => {
      await tx.execute({ sql: 'UPDATE jars SET balance_wei = ? WHERE user_id = ? AND kind = ?', args: [String(target.balanceWei + moved), user.id, kind] })
      if (moved > 0n) await tx.execute({ sql: `INSERT INTO activity(user_id, type, jar, amount_wei, title, created_at) VALUES (?, 'move', ?, ?, ?, ?)`, args: [user.id, kind, String(moved), `Allocated G$ ${formatEther(moved)} to ${JAR_INFO[kind].label}`, Date.now()] })
      if (request) await tx.execute({ sql: 'UPDATE money_requests SET result = ? WHERE id = ?', args: [JSON.stringify(result), request.id] })
    })
    return result
  })
}

/** Explicit user-approved budget change. This never moves tokens on-chain. */
export async function reallocateJar(user: User, from: JarKind | 'free', to: JarKind, amount: bigint, requestId: string) {
  return withUserLock(user.id, async () => {
    if (from === to || amount <= 0n) throw new Error('Choose different jars and a positive amount.')
    const request = await moneyRequest(user.id, `budget:${requestId}`, { from, to, amount: String(amount) })
    if (request.result) return
    if ((await run("SELECT 1 FROM payments WHERE user_id = ? AND status IN ('reserved', 'refunding')", [user.id])).rows.length) throw new Error('Wait for your pending payment or refund before changing budgets.')
    const balance = await spendableWei(user)
    await atomic(async (tx) => {
      const rows = (await tx.execute({ sql: 'SELECT kind, balance_wei FROM jars WHERE user_id = ?', args: [user.id] })).rows
      const balances = new Map(rows.map((r) => [String(r.kind), BigInt(String(r.balance_wei))]))
      const allocated = [...balances.values()].reduce((sum, n) => sum + n, 0n)
      if (allocated > balance) throw new Error('Your wallet balance changed. Refresh before moving budgets.')
      const available = from === 'free' ? balance - allocated : balances.get(from) ?? 0n
      if (available < amount) throw new Error('Not enough G$ in the selected source.')
      if (from !== 'free') await tx.execute({ sql: 'UPDATE jars SET balance_wei = ? WHERE user_id = ? AND kind = ?', args: [String(available - amount), user.id, from] })
      await tx.execute({ sql: 'UPDATE jars SET balance_wei = ? WHERE user_id = ? AND kind = ?', args: [String((balances.get(to) ?? 0n) + amount), user.id, to] })
      await tx.execute({ sql: `INSERT INTO activity(user_id, type, jar, amount_wei, title, operation_id, created_at) VALUES (?, 'move', ?, ?, ?, ?, ?)`, args: [user.id, to, String(amount), `Moved G$ ${formatEther(amount)} from ${from} to ${to}`, request.id, Date.now()] })
      await tx.execute({ sql: 'UPDATE money_requests SET result = ? WHERE id = ?', args: ['{"ok":true}', request.id] })
    })
  })
}

export async function snapshot(user: User): Promise<Snapshot> {
  const [power, jars, rate] = await Promise.all([spendingPower(user), getJars(user.id), ngnPerGd()])
  const balance = power.totalWei
  const walletWei = user.rootAddress ? power.walletWei || (await gdBalance(user.rootAddress).catch(() => null)) : null
  // Gas only matters to people still on the older setup; in wallet mode Jara fronts it.
  const gas = user.connected && power.mode === 'jar' ? await gasStatus(user.agentAddress).catch(() => null) : null
  const allocated = jars.reduce((s, j) => s + j.balanceWei, 0n)
  const pending = (await run("SELECT 1 FROM payments WHERE user_id = ? AND status IN ('reserved', 'refunding') LIMIT 1", [user.id])).rows.length > 0
  const free = !pending && balance > allocated ? balance - allocated : 0n
  const toGd = (w: bigint) => Number(formatEther(w))
  return {
    jars: jars.map((j) => {
      // A wallet owner may spend/revoke permission outside Jara between syncs.
      // Never display more allocated G$ than the current spending balance.
      const visibleWei = allocated > balance && allocated > 0n ? (j.balanceWei * balance) / allocated : j.balanceWei
      const balanceNgn = Math.floor(toGd(visibleWei) * rate)
      return {
        kind: j.kind,
        label: JAR_INFO[j.kind].label,
        emoji: JAR_INFO[j.kind].emoji,
        balanceGd: toGd(visibleWei),
        balanceNgn,
        targetNgn: j.targetNgn,
        pct: j.targetNgn > 0 ? Math.min(100, Math.round((balanceNgn / j.targetNgn) * 100)) : 0,
        autoPay: j.autoPay,
        details: j.details,
        everyDays: j.everyDays,
        dueAt: jarDueAt(j),
      }
    }),
    totalGd: toGd(balance),
    freeGd: toGd(free),
    freeNgn: Math.floor(toGd(free) * rate),
    ngnPerGd: rate,
    walletGd: walletWei === null ? null : toGd(walletWei),
    gas,
    mode: power.mode,
    claimedGd: toGd(power.agentAvailWei),
    limitLeftGd: toGd(power.allowanceWei),
    feesOwedGd: toGd(power.owedWei),
  }
}

/** What a jar can pay right now: its own balance plus G$ not budgeted to any jar. Other jars are never borrowed. */
export async function jarSpendable(user: User, kind: JarKind): Promise<bigint> {
  const [total, jars] = await Promise.all([spendableWei(user), getJars(user.id)])
  const allocated = jars.reduce((s, j) => s + j.balanceWei, 0n)
  const own = jars.find((j) => j.kind === kind)?.balanceWei ?? 0n
  return own + (total > allocated ? total - allocated : 0n)
}
