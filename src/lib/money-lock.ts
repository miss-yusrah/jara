import { randomUUID } from 'node:crypto'
import { db, moneyLockContext } from './db'

const LEASE_MS = 120_000

export class MoneyBusyError extends Error {
  constructor() {
    super('Another operation is still processing. Retry the same request shortly.')
    this.name = 'MoneyBusyError'
  }
}

/**
 * Shared across server processes; nested calls for the same user are safe.
 * `waitMs` queues behind the current holder for that long (used for the shared
 * treasury signer, so two people paying at once both go through) before giving up.
 */
export async function withMoneyLock<T>(id: string, fn: () => Promise<T>, opts: { waitMs?: number } = {}): Promise<T> {
  if (moneyLockContext.getStore()?.has(id)) return fn()
  const client = await db()
  const owner = randomUUID()
  const deadline = Date.now() + (opts.waitMs ?? 0)
  for (;;) {
    const acquired = await client.execute({
      sql: `INSERT INTO money_locks(id, owner, expires_at) VALUES (?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at
        WHERE money_locks.expires_at < ?`,
      args: [id, owner, Date.now() + LEASE_MS, Date.now()],
    })
    if (acquired.rowsAffected) break
    if (Date.now() >= deadline) throw new MoneyBusyError()
    await new Promise((r) => setTimeout(r, 400 + Math.random() * 300))
  }
  const heartbeat = setInterval(() => {
    void client.execute({ sql: 'UPDATE money_locks SET expires_at = ? WHERE id = ? AND owner = ?', args: [Date.now() + LEASE_MS, id, owner] }).catch(() => undefined)
  }, LEASE_MS / 3)
  heartbeat.unref()
  try {
    const context = new Map(moneyLockContext.getStore())
    context.set(id, owner)
    return await moneyLockContext.run(context, fn)
  } finally {
    clearInterval(heartbeat)
    await client.execute({ sql: 'DELETE FROM money_locks WHERE id = ? AND owner = ?', args: [id, owner] })
  }
}
