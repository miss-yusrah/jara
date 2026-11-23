import { loadEnvFile } from 'node:process'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'

// Keep secrets out of process arguments, crontab and logs.
const root = new URL('../', import.meta.url)
const started = Date.now()
try {
  loadEnvFile(fileURLToPath(new URL('.env.production.local', root)))
  if (!process.env.CRON_SECRET) throw new Error('Missing cron configuration')
  const response = await fetch('http://127.0.0.1:3400/api/cron/claims', {
    method: 'POST',
    headers: { authorization: `Bearer ${process.env.CRON_SECRET}` },
    signal: AbortSignal.timeout(285_000),
  })
  if (!response.ok) throw new Error('Claim endpoint unavailable')
  const result = await response.json()
  const results = result.results ?? []
  const status = {
    checkedAt: new Date().toISOString(), durationMs: Date.now() - started,
    ran: result.ran ?? 0, skipped: Boolean(result.skipped),
    claimed: results.filter((r) => r.claimStatus === 'claimed').length,
    reconnect: results.filter((r) => r.claimStatus === 'reconnect').length,
    retries: results.filter((r) => !r.ok && r.claimStatus !== 'reconnect').length,
  }
  await mkdir(new URL('data/', root), { recursive: true })
  await writeFile(new URL('data/claims-status.json.tmp', root), JSON.stringify(status) + '\n', { mode: 0o600 })
  await rename(new URL('data/claims-status.json.tmp', root), new URL('data/claims-status.json', root))
} catch {
  console.error(`${new Date().toISOString()} Claim check failed; retrying next hour.`)
  process.exitCode = 1
}
