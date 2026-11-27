import { verifyWebhook } from '@goodcash/sdk/server'
import { atomic } from './db'
import { serverConfig } from './env'
import { getUserById } from './users'

// GoodCash: cash G$ out to a Nigerian bank, or add G$ by paying naira. Non-custodial: the person's
// own wallet signs; GoodCash never holds money or keys. Jara only records what GoodCash reports here,
// from signed webhooks, never from browser events.
//
// These are their own activity types ('cashout', 'topup'), never 'pay' or 'deposit': a bank cash
// out is not a bill, so it must not unlock the first-bill reward, count as a bill in stats or the
// treasury report, or be reported as a Jara deposit.

type EventData = { id?: string; partnerRef?: string | null; wallet?: string; amountG?: string | number; amountNaira?: number; receive?: { naira?: number }; asset?: string; mode?: string }
type Event = { id: string; type: string; data: EventData }

export type WebhookOutcome = { status: number; body: Record<string, unknown> }

const naira = (n: number) => `₦${Number(n).toLocaleString('en-NG')}`

/** What each event writes to the person's activity, or null to acknowledge it quietly. */
function entry(event: Event): { type: 'cashout' | 'topup'; status: string; title: string; detail: string; amountNgn: number | null } | null {
  const d = event.data
  switch (event.type) {
    case 'cashout.paid':
      return { type: 'cashout', status: 'done', title: d.receive?.naira != null ? `Cashed out to your bank · ${naira(d.receive.naira)}` : 'Cashed out G$ to your bank', detail: d.amountG != null ? `G$ ${d.amountG} via GoodCash` : 'Paid via GoodCash', amountNgn: d.receive?.naira ?? null }
    case 'cashout.failed':
    case 'cashout.expired':
      return { type: 'cashout', status: 'failed', title: 'Bank cash out did not complete', detail: `GoodCash ${event.type}`, amountNgn: null }
    case 'cashout.refunded':
      return { type: 'cashout', status: 'refunded', title: 'Bank cash out refunded to your wallet', detail: 'GoodCash cashout.refunded', amountNgn: null }
    case 'topup.delivered':
      return { type: 'topup', status: 'done', title: d.amountNaira != null ? `Added ${d.asset === 'celo' ? 'CELO' : 'G$'} with ${naira(d.amountNaira)}` : 'Added G$ with naira', detail: 'Delivered to your wallet via GoodCash', amountNgn: d.amountNaira ?? null }
    case 'topup.failed':
      return { type: 'topup', status: 'failed', title: 'Naira top-up did not complete', detail: 'GoodCash topup.failed', amountNgn: null }
    default:
      return null // cashout.delayed, topup.paid_in, cashout.test…: acknowledged, nothing to show
  }
}

/**
 * Verify on the raw body, then record once per event id. A 5xx answer makes GoodCash retry
 * (about 10 min, 30 min, 2 h, 12 h); the same event arriving again is ignored.
 */
export async function handleGoodCashWebhook(raw: string, signature: string | null): Promise<WebhookOutcome> {
  const secret = serverConfig().goodcash.webhookSecret
  if (!secret) return { status: 503, body: { error: 'Webhook not configured' } }
  let event: Event
  try {
    event = await verifyWebhook<Event>(raw, signature, secret) as unknown as Event
  } catch (err) {
    console.warn('[goodcash] webhook rejected', err instanceof Error ? err.message : 'invalid')
    return { status: 400, body: { error: 'Bad signature' } }
  }
  const row = entry(event)
  if (!row) return { status: 200, body: { ok: true, ignored: event.type } }

  const userId = typeof event.data.partnerRef === 'string' ? event.data.partnerRef : null
  const user = userId ? await getUserById(userId) : null
  // partnerRef comes from the browser, so it alone proves nothing: the wallet GoodCash saw must be
  // this account's verified wallet. Otherwise acknowledge (no retries) and record nothing.
  if (!user || !user.rootAddress || typeof event.data.wallet !== 'string' || event.data.wallet.toLowerCase() !== user.rootAddress.toLowerCase()) {
    console.warn('[goodcash] event not matched to an account', event.type, event.id)
    return { status: 200, body: { ok: true, ignored: 'unmatched' } }
  }

  try {
    const inserted = await atomic(async (tx) => (await tx.execute({
      sql: `INSERT OR IGNORE INTO activity (user_id, type, amount_ngn, status, title, detail, provider, provider_ref, operation_id, created_at)
            VALUES (?, ?, ?, ?, ?, ?, 'goodcash', ?, ?, ?)`,
      args: [user.id, row.type, row.amountNgn, row.status, row.title, row.detail, event.data.id ?? null, `goodcash:event:${event.id}`, Date.now()],
    })).rowsAffected)
    return { status: 200, body: inserted ? { ok: true } : { ok: true, duplicate: true } }
  } catch (err) {
    console.error('[goodcash] webhook not recorded, GoodCash will retry', event.id, err instanceof Error ? err.message : 'error')
    return { status: 500, body: { error: 'Not recorded yet' } }
  }
}
