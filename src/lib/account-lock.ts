import { run } from './db'
import { withMoneyLock } from './money-lock'

/** Serialize all accounts using the same funding wallet, across workers. */
export async function withAccountLock<T>(userId: string, fn: () => Promise<T>): Promise<T> {
  return withMoneyLock(`user:${userId}`, async () => {
    const row = (await run('SELECT root_address FROM users WHERE id = ?', [userId])).rows[0]
    const root = row?.root_address
    return root ? withMoneyLock(`wallet:${String(root).toLowerCase()}`, fn) : fn()
  })
}

/** An uncertain shared-wallet charge must settle before either account spends again. */
export async function hasPendingFunds(userId: string, rootAddress: string | null): Promise<boolean> {
  const result = await run(`SELECT 1 FROM payments WHERE status IN ('reserved', 'refunding')
    AND (user_id = ? OR (source = 'wallet' AND lower(refund_address) = ?)) LIMIT 1`,
  [userId, rootAddress?.toLowerCase() ?? ''])
  return result.rows.length > 0
}
