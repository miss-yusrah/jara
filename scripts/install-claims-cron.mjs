import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

if (!existsSync('/opt/jara/.env.production.local')) throw new Error('Run this on the Jara server')
const current = spawnSync('crontab', ['-l'], { encoding: 'utf8' })
if (current.error || (current.status !== 0 && !current.stderr.includes('no crontab'))) throw new Error('Cannot read existing crontab')
const lines = current.stdout.split('\n').filter((line) => !line.includes('# jara-claims'))
const node = process.execPath
if (!/^\/[a-zA-Z0-9/_.-]+$/.test(node)) throw new Error('Unsupported Node path')
execFileSync('flock', ['--version'], { stdio: 'ignore' })
// Five minutes after the hour avoids reading a block from just before the UBI reset.
lines.push(`5 * * * * flock -n /tmp/jara-claims.lock ${node} /opt/jara/scripts/claims-cron.mjs >> /opt/jara/data/claims-cron.log 2>&1 # jara-claims`)
execFileSync('crontab', ['-'], { input: lines.filter(Boolean).join('\n') + '\n' })
console.log('Claim schedule installed: hourly at minute 5. Existing schedules preserved.')
