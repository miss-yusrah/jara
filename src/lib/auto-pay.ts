import { describeAction, payBill, prepareBill, type BillResult } from './bills'
import { run } from './db'
import { serverConfig } from './env'
import { getJars, jarDueAt, syncJars, withUserLock } from './jars'
import { MoneyBusyError, withMoneyLock } from './money-lock'
import { gdForNgn } from './price'
import { getUserById, isBillKind, type PendingAction, type User } from './users'
import { authorizedUser } from './wallet-authorization'

const paymentDay = (at: number) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos' }).format(at)
type AutoPayment = { description: string; result: BillResult }

/** No claims or AI jobs: safe to run after a balance change and every minute.
 * The original daily/cadence purchase IDs are shared with the daily agent.
 * A full jar buys at most once per Lagos day, even if free funds refill it.
 */
export async function checkAutoPay(user: User): Promise<AutoPayment[]> {
  if (!user.connected || !serverConfig().billsLive) return []
  return withUserLock(user.id, async () => {
    const payments: AutoPayment[] = []
    const resumed = new Set<string>()
    // Resume before testing balances/dates: a charge may already have emptied
    // the jar, and a provider response may arrive after midnight or a restart.
    const pending = (await run('SELECT data FROM money_requests WHERE user_id = ? AND id LIKE ? AND result IS NULL AND data IS NOT NULL ORDER BY created_at', [user.id, `${user.id}:bill:auto:%`])).rows
    const jars = await getJars(user.id)
    const enabled = jars.some((jar) => jar.autoPay && isBillKind(jar.kind))
    if (!enabled && !pending.length) return payments
    user = await authorizedUser(user)
    for (const row of pending) {
      const { action } = JSON.parse(String(row.data)) as { action: PendingAction }
      resumed.add(action.kind)
      payments.push({ description: describeAction(action), result: await payBill(user, action) })
    }

    if (!enabled) return payments
    // Don't reconcile or start new purchases while funds are reserved/refunding.
    if ((await run("SELECT 1 FROM payments WHERE user_id = ? AND status IN ('reserved', 'refunding') LIMIT 1", [user.id])).rows.length) return payments
    await syncJars(user)
    const today = paymentDay(Date.now())
    for (const jar of await getJars(user.id)) {
      if (!isBillKind(jar.kind) || !jar.autoPay || jar.targetNgn <= 0 || resumed.has(jar.kind)) continue
      const due = jarDueAt(jar)
      if (due !== null && due > Date.now()) continue
      // Also prevents a late success, or a switch from cadence to when-full,
      // from immediately starting a second payment that same day.
      if (!jar.everyDays && jar.lastPaidAt && paymentDay(jar.lastPaidAt) === today) continue
      const id = `auto:${jar.kind}:${jar.everyDays ? jar.lastPaidAt ?? 0 : today}`
      if ((await run('SELECT 1 FROM money_requests WHERE id = ?', [`${user.id}:bill:${id}`])).rows.length) continue
      // A manual bill for this jar must finish before an automatic one starts.
      if ((await run("SELECT 1 FROM activity WHERE user_id = ? AND jar = ? AND type = 'pay' AND status IN ('pending', 'settling', 'refund_pending') LIMIT 1", [user.id, jar.kind])).rows.length) continue
      if (jar.balanceWei < await gdForNgn(jar.targetNgn)) continue
      const prepared = await prepareBill(user, { id, kind: jar.kind, amountNgn: jar.targetNgn })
      if ('error' in prepared || BigInt(prepared.action.quoteWei!) > jar.balanceWei) continue
      payments.push({ description: describeAction(prepared.action), result: await payBill(user, prepared.action) })
    }
    return payments
  })
}

/** The minute sweep is also the durable fallback if a post-response check is
 * interrupted. It reads saved jar settings and purchase journals, not memory.
 */
export async function runAutoPayForAll() {
  return withMoneyLock('cron:auto-pay', async () => {
    const rows = (await run(`SELECT u.id FROM users u WHERE u.connected = 1 AND (
      EXISTS (SELECT 1 FROM jars j WHERE j.user_id = u.id AND j.auto_pay = 1 AND j.kind IN ('airtime', 'data', 'light'))
      OR EXISTS (SELECT 1 FROM money_requests m WHERE m.user_id = u.id AND m.id LIKE u.id || ':bill:auto:%' AND m.result IS NULL AND m.data IS NOT NULL)
    )`)).rows
    const results: { userId: string; status: 'checked' | 'busy' | 'retry'; payments?: number }[] = []
    for (const row of rows) {
      const userId = String(row.id)
      try {
        const user = await getUserById(userId)
        const payments = user ? await checkAutoPay(user) : []
        results.push({ userId, status: 'checked', payments: payments.length })
      } catch (err) {
        results.push({ userId, status: err instanceof MoneyBusyError ? 'busy' : 'retry' })
        if (!(err instanceof MoneyBusyError)) console.warn('[auto-pay] check deferred', userId)
      }
    }
    return results
  })
}
