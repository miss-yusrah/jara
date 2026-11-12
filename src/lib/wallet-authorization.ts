import { whitelistedRoot } from './chain'
import { serverConfig } from './env'
import { getUserById, type User } from './users'
import { atomic, run } from './db'

/** The Jara account this GoodDollar wallet already belongs to, if any (other than `exceptUserId`). */
export async function accountForWallet(rootAddress: string, exceptUserId?: string): Promise<string | null> {
  const addr = rootAddress.toLowerCase()
  const bound = (await run('SELECT user_id FROM wallet_bindings WHERE root_address = ?', [addr])).rows[0]
  if (bound && bound.user_id !== exceptUserId) return String(bound.user_id)
  const other = (await run('SELECT id FROM users WHERE lower(root_address) = ? AND connected = 1 AND id != ? LIMIT 1', [addr, exceptUserId ?? ''])).rows[0]
  return other ? String(other.id) : null
}

export const WALLET_LINKED_MESSAGE = 'This wallet already has a Jara account. Sign back in with this wallet to open it.'

export async function bindWallet(userId: string, rootAddress: string) {
  await atomic(async (tx) => {
    const root = rootAddress.toLowerCase()
    const shared = (await tx.execute({ sql: `SELECT s.user_id FROM wallet_sharing s JOIN users u ON u.id = s.user_id
      WHERE s.root_address = ? AND lower(u.root_address) = ? AND u.connected = 1 ORDER BY u.created_at, u.id`, args: [root, root] })).rows.map((r) => String(r.user_id))
    const approved = shared.includes(userId)
    if (!approved) {
      const other = await tx.execute({ sql: 'SELECT 1 FROM users WHERE lower(root_address) = ? AND connected = 1 AND id != ?', args: [root, userId] })
      if (other.rows.length) throw new Error(WALLET_LINKED_MESSAGE)
    }
    await tx.execute({ sql: 'INSERT OR IGNORE INTO wallet_bindings(root_address, user_id) VALUES (?, ?)', args: [root, approved ? shared[0] : userId] })
    const binding = (await tx.execute({ sql: 'SELECT user_id FROM wallet_bindings WHERE root_address = ?', args: [root] })).rows[0]
    if (binding?.user_id !== userId && !(approved && shared.includes(String(binding?.user_id)))) throw new Error(WALLET_LINKED_MESSAGE)
  })
}

/** Check the live link before spending; an address or token allowance is not authentication. */
export async function authorizedUser(input: User): Promise<User> {
  const user = await getUserById(input.id)
  if (!user?.connected || !user.rootAddress) throw new Error('Connect your GoodDollar account first.')
  if (serverConfig().chain.mode !== 'mock') {
    const root = await whitelistedRoot(user.agentAddress)
    if (!root || root.toLowerCase() !== user.rootAddress.toLowerCase()) {
      throw new Error('Your wallet link has changed. Reconnect your GoodDollar account before spending.')
    }
    await bindWallet(user.id, user.rootAddress)
  }
  return user
}
