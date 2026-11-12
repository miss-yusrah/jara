import { execFileSync, spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'

// Run on the VPS after a successful deployment. Preserve all other schedules.
if (!existsSync('/opt/jara/.env.production.local')) throw new Error('Run this on the Jara server')
const current = spawnSync('crontab', ['-l'], { encoding: 'utf8' })
if (current.error || (current.status !== 0 && !current.stderr.includes('no crontab'))) throw new Error('Cannot read existing crontab')
const lines = current.stdout.split('\n').filter((line) => !line.includes('# jara-auto-pay'))
const node = process.execPath
if (!/^\/[a-zA-Z0-9/_.-]+$/.test(node)) throw new Error('Unsupported Node path')
execFileSync('flock', ['--version'], { stdio: 'ignore' })
lines.push(`* * * * * flock -n /tmp/jara-auto-pay.lock ${node} /opt/jara/scripts/auto-pay-cron.mjs >> /opt/jara/data/auto-pay-cron.log 2>&1 # jara-auto-pay`)
execFileSync('crontab', ['-'], { input: lines.filter(Boolean).join('\n') + '\n' })
console.log('Auto-pay schedule installed: every minute. Existing schedules preserved.')
