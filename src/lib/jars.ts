import { formatEther } from 'viem'
import { gdBalance } from './chain'
import { run } from './db'
import { gdForNgn, ngnPerGd } from './price'
import { JAR_INFO, JAR_KINDS, logActivity, type JarKind, type User } from './users'

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
}

// One operation per user at a time, so two messages can't spend the same G$.
const locks = new Map<string, Promise<unknown>>()
export async function withUserLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  const prev = locks.get(userId) ?? Promise.resolve()
  const next = prev.catch(() => undefined).then(fn)
  locks.set(userId, next)
  try {
    return await next
  } finally {
    if (locks.get(userId) === next) locks.delete(userId)
  }
}

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

async function setJarBalance(userId: string, kind: JarKind, wei: bigint) {
  await run('UPDATE jars SET balance_wei = ? WHERE user_id = ? AND kind = ?', [wei.toString(), userId, kind])
}

export async function updateJar(
  userId: string,
  kind: JarKind,
  patch: Partial<{ targetNgn: number; autoPay: boolean; details: JarDetails; everyDays: number | null }>,
) {
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
  const balance = await gdBalance(user.agentAddress)
  const jars = await getJars(user.id)
  const allocated = jars.reduce((s, j) => s + j.balanceWei, 0n)

  if (balance < allocated) {
    // Balance dropped outside Jara: shrink jars proportionally so the ledger never exceeds reality.
    for (const j of jars) {
      const next = allocated === 0n ? 0n : (j.balanceWei * balance) / allocated
      await setJarBalance(user.id, j.kind, next)
    }
    return 0n
  }

  let free = balance - allocated
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
  for (let i = 0; i < jars.length; i++) {
    const share = i === jars.length - 1 ? pool - given : (pool * needs[i]) / totalNeed
    const capped = share > needs[i] ? needs[i] : share
    given += capped
    await setJarBalance(user.id, jars[i].kind, jars[i].balanceWei + capped)
  }
  free -= given
  return given
}

/** Move naira-worth of G$ into a jar, taking from free balance first, then other jars. */
export async function moveToJar(user: User, kind: JarKind, ngn: number): Promise<{ movedGd: number }> {
  const want = await gdForNgn(ngn)
  const balance = await gdBalance(user.agentAddress)
  const jars = await getJars(user.id)
  const target = jars.find((j) => j.kind === kind)!
  let free = balance - jars.reduce((s, j) => s + j.balanceWei, 0n)
  if (free < 0n) free = 0n
  let moved = want < free ? want : free
  for (const j of jars) {
    if (moved >= want || j.kind === kind) continue
    const take = want - moved < j.balanceWei ? want - moved : j.balanceWei
    await setJarBalance(user.id, j.kind, j.balanceWei - take)
    moved += take
  }
  await setJarBalance(user.id, kind, target.balanceWei + moved)
  if (moved > 0n) {
    await logActivity(user.id, {
      type: 'move',
      jar: kind,
      amountWei: moved.toString(),
      title: `Moved G$ ${Number(formatEther(moved)).toFixed(0)} into ${JAR_INFO[kind].label}`,
    })
  }
  return { movedGd: Number(formatEther(moved)) }
}

/** Take G$ out of a jar ledger (used when paying from it). Spills into free balance, then other jars. */
export async function debitJars(user: User, kind: JarKind, amount: bigint): Promise<boolean> {
  const balance = await gdBalance(user.agentAddress)
  if (balance < amount) return false
  const jars = await getJars(user.id)
  let remaining = amount
  const primary = jars.find((j) => j.kind === kind)!
  const fromPrimary = remaining < primary.balanceWei ? remaining : primary.balanceWei
  await setJarBalance(user.id, kind, primary.balanceWei - fromPrimary)
  remaining -= fromPrimary
  const free = balance - jars.reduce((s, j) => s + j.balanceWei, 0n)
  if (remaining > 0n && free > 0n) remaining -= remaining < free ? remaining : free
  for (const j of jars) {
    if (remaining === 0n || j.kind === kind) continue
    const take = remaining < j.balanceWei ? remaining : j.balanceWei
    await setJarBalance(user.id, j.kind, j.balanceWei - take)
    remaining -= take
  }
  return remaining === 0n
}

export async function creditJar(userId: string, kind: JarKind, amount: bigint) {
  const jar = (await getJars(userId)).find((j) => j.kind === kind)!
  await setJarBalance(userId, kind, jar.balanceWei + amount)
}

export async function snapshot(user: User): Promise<Snapshot> {
  const [balance, jars, rate] = await Promise.all([gdBalance(user.agentAddress), getJars(user.id), ngnPerGd()])
  const allocated = jars.reduce((s, j) => s + j.balanceWei, 0n)
  const free = balance > allocated ? balance - allocated : 0n
  const toGd = (w: bigint) => Number(formatEther(w))
  return {
    jars: jars.map((j) => {
      const balanceNgn = Math.floor(toGd(j.balanceWei) * rate)
      return {
        kind: j.kind,
        label: JAR_INFO[j.kind].label,
        emoji: JAR_INFO[j.kind].emoji,
        balanceGd: toGd(j.balanceWei),
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
  }
}
