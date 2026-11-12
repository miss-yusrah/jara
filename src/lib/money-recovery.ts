import { recoverPaidJobs } from './ai-tools'
import { recoverChatPayments } from './ai-chat'
import { recoverChainTransactions } from './chain-outbox'
import { run } from './db'
import { withUserLock, syncJars } from './jars'
import { withdrawToWallet } from './spend'
import type { User } from './users'

export { recoverChainTransactions }

export async function recoverUserPayments(user: User) {
  await recoverPaidJobs(user)
  await recoverChatPayments(user)
  const withdrawals = (await run('SELECT id FROM money_requests WHERE user_id = ? AND result IS NULL AND data IS NOT NULL AND id LIKE ?', [user.id, `${user.id}:withdraw:%`])).rows
  for (const row of withdrawals) {
    const key = String(row.id).slice(`${user.id}:withdraw:`.length)
    await withUserLock(user.id, async () => {
      await withdrawToWallet(user, key)
      await syncJars(user)
    }).catch(() => undefined)
  }
}
