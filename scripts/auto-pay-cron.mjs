import { loadEnvFile } from 'node:process'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

// Keep the secret out of crontab, process arguments and logs.
const root = new URL('../', import.meta.url)
const started = Date.now()
try {
  loadEnvFile(fileURLToPath(new URL('.env.production.local', root)))
  if (!process.env.CRON_SECRET) throw new Error('Missing cron configuration')
  const response = await fetch('http://127.0.0.1:3400/api/cron/auto-pay', {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
    signal: AbortSignal.timeout(285_000),
  })
  if (!response.ok) throw new Error('Auto-pay endpoint unavailable')
  const result = await response.json()
  const results = result.results ?? []
  const status = {
    checkedAt: new Date().toISOString(), durationMs: Date.now() - started,
    ran: result.ran ?? 0, skipped: Boolean(result.skipped),
    busy: results.filter((r) => r.status === 'busy').length,
    retries: results.filter((r) => r.status === 'retry').length,
    payments: results.reduce((sum, r) => sum + (r.payments ?? 0), 0),
  }
  await mkdir(new URL('data/', root), { recursive: true })
  await writeFile(new URL('data/auto-pay-status.json.tmp', root), JSON.stringify(status) + '\n', { mode: 0o600 })
  await rename(new URL('data/auto-pay-status.json.tmp', root), new URL('data/auto-pay-status.json', root))
} catch {
  console.error(`${new Date().toISOString()} Auto-pay check failed; retrying on the next tick.`)
  process.exitCode = 1
}
