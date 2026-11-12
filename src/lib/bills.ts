import { createHash, randomUUID } from 'node:crypto'
import { formatEther } from 'viem'
import {
  DISCO_INFO,
  NETWORK_INFO,
  detectNetwork,
  formatNgn,
  formatPhone,
  formatToken,
  isDisco,
  isMeterType,
  isNetwork,
  normalizeMeterNumber,
  normalizePhone,
  type Network,
} from './catalog'
import { CELOSCAN_TX } from './chain'
import { refundPayment, spendGd } from './spend'
import { moneyRequest } from './money-request'
import { atomic } from './db'
import { run } from './db'
import { serverConfig, testNumbersAllowed } from './env'
import { getJars, syncJars, withUserLock } from './jars'
import { gdForNgn } from './price'
import { getProviderByName, getTopupProvider, type TopupResult } from './providers'
import { sendMessage } from './telegram'
import { getUserById, updateActivity, type PendingAction, type User } from './users'

export interface BillResult {
  ok: boolean
  pending?: boolean
  message: string
  token?: string
  txHash?: string
  explorerUrl?: string
}

const allowTestNumbers = () => testNumbersAllowed()

/**
 * Fill in and check a bill before showing it to the user for confirmation.
 * Returns a complete PendingAction, or an error the agent can relay.
 */
export async function prepareBill(
  user: User,
  draft: Omit<PendingAction, 'createdAt'>,
): Promise<{ action: PendingAction } | { error: string }> {
  if (!serverConfig().billsLive) {
    return { error: "I can't pay bills just yet. For now I save your G$, collect rewards, and Jara AI can help with research, assignments and more." }
  }
  const { maxBillNgn } = serverConfig().limits
  const amount = Math.round(draft.amountNgn)
  if (!Number.isFinite(amount) || amount <= 0) return { error: 'How much should I pay? Give me an amount in naira.' }

  const jars = await getJars(user.id)
  const d = jars.find((j) => j.kind === draft.kind)!.details
  // "for me" with no number: use whichever jar already knows the user's phone.
  const savedPhone = d.phone ?? jars.find((j) => j.details.phone)?.details.phone
  const action: PendingAction = { ...draft, id: draft.id ?? randomUUID(), amountNgn: amount, createdAt: Date.now() }

  if (draft.kind === 'airtime' || draft.kind === 'data') {
    const phone = normalizePhone(draft.phone ?? savedPhone ?? '', allowTestNumbers())
    if (!phone) return { error: 'Which phone number? Send it like 0803 123 4567.' }
    const network = (isNetwork(draft.network) ? draft.network : null) ?? detectNetwork(phone) ?? (jars.find((j) => j.details.phone === phone && isNetwork(j.details.network))?.details.network as Network | undefined) ?? null
    if (!network) return { error: `Which network is ${formatPhone(phone)} on — MTN, Airtel, Glo or 9mobile?` }
    action.phone = phone
    action.network = network
    if (draft.kind === 'airtime' && amount < 50) return { error: 'Airtime starts from ₦50.' }
    if (draft.kind === 'data') {
      const plans = await getTopupProvider().listDataPlans(network)
      const byCode = draft.planCode ? plans.find((p) => p.code === draft.planCode) : undefined
      const affordable = plans.filter((p) => p.amountNgn <= amount)
      const plan = byCode ?? matchPlanName(plans, draft.planName) ?? affordable[affordable.length - 1]
      if (!plan) return { error: `The cheapest ${NETWORK_INFO[network].label} data plan is ${formatNgn(plans[0]?.amountNgn ?? 0)}.` }
      action.planCode = plan.code
      action.planName = plan.name
      action.amountNgn = plan.amountNgn
    }
  }

  if (draft.kind === 'light') {
    const disco = draft.disco ?? d.disco
    const meterType = draft.meterType ?? d.meterType ?? 'prepaid'
    const meter = normalizeMeterNumber(draft.meterNumber ?? d.meterNumber ?? '')
    if (!isDisco(disco) || !meter || !isMeterType(meterType)) {
      return { error: 'I need your meter details first. Set up your Light jar in the app (meter number + electricity company).' }
    }
    if (amount < DISCO_INFO[disco].minNgn) return { error: `${DISCO_INFO[disco].short} needs at least ${formatNgn(DISCO_INFO[disco].minNgn)}.` }
    action.disco = disco
    action.meterType = meterType
    action.meterNumber = meter
  }
  if (action.amountNgn > maxBillNgn) return { error: `I can only pay up to ${formatNgn(maxBillNgn)} at once for now.` }
  action.quoteWei = String(await gdForNgn(action.amountNgn))
  return { action }
}

function matchPlanName<T extends { name: string }>(plans: T[], name?: string): T | undefined {
  if (!name) return undefined
  const size = name.toLowerCase().replace(/\s+/g, '').match(/(\d+(?:\.\d+)?)(gb|mb)/)
  if (!size) return undefined
  return plans.find((p) => p.name.toLowerCase().replace(/\s+/g, '').includes(`${size[1]}${size[2]}`))
}

export function describeAction(a: PendingAction): string {
  switch (a.kind) {
    case 'airtime':
      return `${formatNgn(a.amountNgn)} ${NETWORK_INFO[a.network as Network]?.label ?? ''} airtime to ${formatPhone(a.phone ?? '')}`
    case 'data':
      return `${a.planName} ${NETWORK_INFO[a.network as Network]?.label ?? ''} data (${formatNgn(a.amountNgn)}) to ${formatPhone(a.phone ?? '')}`
    case 'light':
      return `${formatNgn(a.amountNgn)} electricity for meter ${a.meterNumber} (${isDisco(a.disco) ? DISCO_INFO[a.disco].short : a.disco})`
  }
}

interface BillData {
  action: PendingAction
  amount: string
  provider: string
  reference: string
  phase: 'charge' | 'ready' | 'submitted' | 'refund'
  outcome?: TopupResult
}

/** One identity for a purchase, persisted before any transfer or provider call. */
export async function payBill(user: User, action: PendingAction): Promise<BillResult> {
  return withUserLock(user.id, async () => {
    const key = action.id ?? createHash('sha256').update(JSON.stringify(action)).digest('hex')
    const intent = Object.fromEntries(Object.entries(action).filter(([key]) => !['createdAt', 'quoteWei', 'id'].includes(key)))
    const request = await moneyRequest<BillData>(user.id, `bill:${key}`, intent)
    if (request.result) return request.result as BillResult
    if (!request.data) {
      const provider = getTopupProvider()
      request.data = { action, amount: action.quoteWei ?? String(await gdForNgn(action.amountNgn)), provider: provider.name, reference: provider.createReference(), phase: 'charge' }
      await request.save(request.data)
    }
    const data = request.data
    const needed = BigInt(data.amount)
    const title = describeAction(data.action)
    await run(`INSERT OR IGNORE INTO activity(user_id, type, jar, amount_wei, amount_ngn, status, title, provider, provider_ref, operation_id, created_at)
      VALUES (?, 'pay', ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
      [user.id, action.kind, data.amount, action.amountNgn, `Paying ${title}`, data.provider, data.reference, request.id, Date.now()])
    const activityId = Number((await run('SELECT id FROM activity WHERE operation_id = ?', [request.id])).rows[0].id)
    let txHash: string | undefined
    if (data.phase === 'charge') {
      await syncJars(user)
      try {
        txHash = (await spendGd(user, needed, { id: request.id, jar: action.kind })).hash
      } catch (err) {
        const p = (await run('SELECT status FROM payments WHERE id = ?', [request.id])).rows[0]
        if (p?.status === 'reserved' || p?.status === 'paid') {
          return { ok: true, pending: true, message: 'Your G$ payment is awaiting confirmation. Jara will check this same payment again.' }
        }
        const message = err instanceof Error ? err.message : 'The payment could not start.'
        await updateActivity(activityId, { status: 'failed', title: `Not paid: ${title}`, detail: message })
        return request.finish({ ok: false, message })
      }
      await updateActivity(activityId, { txHash })
      data.phase = 'ready'
      await request.save(data)
    }
    txHash ??= String((await run('SELECT tx_hash FROM payments WHERE id = ?', [request.id])).rows[0]?.tx_hash ?? '')
    const provider = getProviderByName(data.provider)
    if (data.phase === 'ready') {
      // Mark BEFORE sending. On a timeout/restart, query this reference; never
      // blindly send a second purchase, even if the provider says not found.
      data.phase = 'submitted'
      await request.save(data)
      try {
        const a = data.action
        if (a.kind === 'airtime') data.outcome = await provider.buyAirtime({ network: a.network as Network, phone: a.phone!, amount: a.amountNgn, reference: data.reference })
        else if (a.kind === 'data') data.outcome = await provider.buyData({ network: a.network as Network, phone: a.phone!, planCode: a.planCode!, amount: a.amountNgn, reference: data.reference })
        else data.outcome = await provider.buyElectricity({ disco: a.disco as never, meterType: a.meterType as never, meterNumber: a.meterNumber!, phone: a.phone ?? '08011111111', amount: a.amountNgn, reference: data.reference })
      } catch {
        data.outcome = { state: 'pending', reference: data.reference }
      }
      await request.save(data)
    } else if (data.phase === 'submitted' && data.outcome?.state !== 'success' && data.outcome?.state !== 'failed') {
      data.outcome = await provider.getStatus(data.reference).catch(() => ({ state: 'pending' as const, reference: data.reference }))
      await request.save(data)
    }
    const explorerUrl = txHash && serverConfig().chain.mode === 'celo' ? CELOSCAN_TX(txHash) : undefined
    if (data.outcome?.state === 'success') {
      const token = data.outcome.token ? formatToken(data.outcome.token) : undefined
      // Marking the cycle paid and its activity is one database commit.
      await atomic(async (tx) => {
        const current = (await tx.execute({ sql: 'SELECT status FROM activity WHERE id = ?', args: [activityId] })).rows[0]
        if (current.status === 'done') return
        await tx.execute({ sql: 'UPDATE jars SET last_paid_at = ? WHERE user_id = ? AND kind = ?', args: [Date.now(), user.id, action.kind] })
        await tx.execute({ sql: "UPDATE activity SET status = 'done', title = ?, detail = ? WHERE id = ?", args: [`Paid ${title}`, token ? `Token: ${token}` : `Paid G$ ${formatEther(needed)}`, activityId] })
      })
      return request.finish({ ok: true, message: `Done ✅ ${title}. Paid G$ ${formatEther(needed)}.${token ? `\n\n🔑 Token: ${token}` : ''}`, token, txHash, explorerUrl })
    }
    if (data.outcome?.state === 'failed' || data.phase === 'refund') {
      data.phase = 'refund'
      await request.save(data)
      await updateActivity(activityId, { status: 'refund_pending', title: `Refund pending: ${title}` })
      try {
        const refundHash = await refundPayment(user, request.id)
        await run(`INSERT OR IGNORE INTO activity(user_id, type, jar, amount_wei, tx_hash, status, title, operation_id, created_at) VALUES (?, 'refund', ?, ?, ?, 'done', ?, ?, ?)`, [user.id, action.kind, data.amount, refundHash, `Refunded G$ ${formatEther(needed)}`, `refund:${request.id}`, Date.now()])
        await updateActivity(activityId, { status: 'failed', title: `Failed: ${title}`, detail: 'G$ refund confirmed to the original funding wallet.' })
        return request.finish({ ok: false, message: `The bill was declined. Your G$ ${formatEther(needed)} refund is confirmed to the wallet that paid.` })
      } catch (err) {
        console.warn('[bills] refund still pending', request.id, err instanceof Error ? err.message : err)
        return { ok: false, pending: true, message: 'The bill was declined. Your refund is still pending; Jara will keep checking it.' }
      }
    }
    return { ok: true, pending: true, message: `Your ${title} is processing. Its outcome is not confirmed yet.`, txHash, explorerUrl }
  })
}

/** Cron, browser refresh and webhooks all resume the original durable request. */
export async function settlePendingBills(onlyReference?: string, onlyUserId?: string): Promise<{ settled: number; stillPending: number }> {
  const where = [onlyReference ? ' AND provider_ref = ?' : '', onlyUserId ? ' AND user_id = ?' : ''].join('')
  const args = [onlyReference, onlyUserId].filter((v): v is string => Boolean(v))
  const rows = (await run(`SELECT * FROM activity WHERE type = 'pay' AND status IN ('pending', 'settling', 'refund_pending')${where} ORDER BY id LIMIT 50`, args)).rows
  let settled = 0
  let stillPending = 0
  for (const row of rows) {
    const user = await getUserById(String(row.user_id))
    if (!user) continue
    try {
      if (!row.operation_id) {
        // Old in-flight payments have no saved signed transfer. Never initiate
        // another charge or guess that a provider's missing record is a failure.
        await settleLegacyBill(user, row)
      } else {
        const saved = (await run('SELECT data FROM money_requests WHERE id = ?', [row.operation_id])).rows[0]
        if (!saved?.data) { stillPending++; continue }
        const data = JSON.parse(String(saved.data)) as BillData
        const result = await payBill(user, data.action)
        if (result.pending) { stillPending++; continue }
      }
      const status = (await run('SELECT status FROM activity WHERE id = ?', [row.id])).rows[0]?.status
      if (status === 'done' || status === 'failed') {
        settled++
        const activity = (await run('SELECT title, detail FROM activity WHERE id = ?', [row.id])).rows[0]
        const text = `${activity.title}${activity.detail ? ` — ${activity.detail}` : ''}`
        const notify = await atomic(async (tx) => {
          const claimed = await tx.execute({ sql: 'INSERT OR IGNORE INTO bill_notices(activity_id, created_at) VALUES (?, ?)', args: [row.id, Date.now()] })
          if (!claimed.rowsAffected) return false
          await tx.execute({ sql: "INSERT INTO messages(user_id, role, content, created_at) VALUES (?, 'assistant', ?, ?)", args: [user.id, text, Date.now()] })
          return true
        })
        if (notify && user.tgChatId) await sendMessage(user.tgChatId, text).catch(() => undefined)
      } else stillPending++
    } catch (err) {
      console.warn('[bills] will retry settlement', row.id, err instanceof Error ? err.message : err)
      stillPending++
    }
  }
  return { settled, stillPending }
}

async function settleLegacyBill(user: User, row: import('@libsql/client').Row) {
  return withUserLock(user.id, async () => {
    const current = (await run('SELECT status FROM activity WHERE id = ?', [row.id])).rows[0]
    if (current.status === 'done' || current.status === 'failed') return
    if (!row.provider || !row.provider_ref) return
    const result = await getProviderByName(String(row.provider)).getStatus(String(row.provider_ref))
    if (result.state === 'success') {
      await atomic(async (tx) => {
        await tx.execute({ sql: "UPDATE activity SET status = 'done', detail = ? WHERE id = ?", args: [result.token ? `Token: ${formatToken(result.token)}` : 'Provider confirmed delivery', row.id] })
        await tx.execute({ sql: 'UPDATE jars SET last_paid_at = ? WHERE user_id = ? AND kind = ?', args: [Date.now(), user.id, row.jar] })
      })
    } else if (result.state === 'failed') {
      // Earlier versions did not journal refunds before sending. They may have
      // refunded already and crashed before saving the result. Preserve the
      // liability for receipt reconciliation; never guess and refund twice.
      await updateActivity(Number(row.id), { status: 'refund_pending', detail: 'Legacy payment: reconcile the original transfer and any refund receipts before releasing funds.' })
    }
  })
}
