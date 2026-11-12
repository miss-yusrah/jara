import { createHash } from 'node:crypto'
import { run } from './db'

export function requestKey(value: unknown): string {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9:_-]{8,160}$/.test(value)) throw new Error('A valid request ID is required. Refresh and try again.')
  return value
}

/** A key is scoped to its owner and permanently bound to one request body. */
export async function moneyRequest<T = unknown>(userId: string, key: string, input: unknown) {
  const id = `${userId}:${key}`
  const fingerprint = createHash('sha256').update(JSON.stringify(input)).digest('hex')
  await run('INSERT OR IGNORE INTO money_requests(id, user_id, fingerprint, created_at) VALUES (?, ?, ?, ?)', [id, userId, fingerprint, Date.now()])
  const row = (await run('SELECT * FROM money_requests WHERE id = ?', [id])).rows[0]
  if (row.fingerprint !== fingerprint) throw new Error('This request ID was already used for a different request.')
  return {
    id,
    data: row.data ? JSON.parse(String(row.data)) as T : null,
    result: row.result ? JSON.parse(String(row.result)) : null,
    save: async (data: T) => { await run('UPDATE money_requests SET data = ? WHERE id = ?', [JSON.stringify(data), id]) },
    finish: async <R>(result: R): Promise<R> => {
      await run('UPDATE money_requests SET result = ? WHERE id = ?', [JSON.stringify(result), id])
      return JSON.parse(JSON.stringify(result)) as R
    },
  }
}
