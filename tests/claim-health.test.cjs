/* eslint-disable @typescript-eslint/no-require-imports */
const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { parseEther } = require('viem')
const { NextResponse } = require('next/server')
const directory = mkdtempSync(`${tmpdir()}/jara-claim-health-`)
Object.assign(process.env, { DATABASE_URL: `file:${directory}/test.db`, CHAIN_MODE: 'celo', CRON_SECRET: 'claim-test-secret' })
const { db } = require('../src/lib/db.ts')
const chain = require('../src/lib/chain.ts')
const { claimHealth } = require('../src/lib/claim-health.ts')
const session = require('../src/lib/session.ts')
const daily = require('../src/lib/daily.ts')
const { WalletLinkError } = require('../src/lib/wallet-authorization.ts')
const { apiFailure } = require('../src/lib/api-error.ts')
const route = require('../src/app/api/claim/route.ts')
const cron = require('../src/app/api/cron/claims/route.ts')
const { withMoneyLock } = require('../src/lib/money-lock.ts')
const user = { id: 'health-user', connected: true, rootAddress: `0x${'1'.repeat(40)}`, agentAddress: `0x${'2'.repeat(40)}`, claimerActive: true, claimerAddress: `0x${'3'.repeat(40)}` }
let verified = true, linked = true, fail = false, amount = 0n, reads = 0
chain.whitelistedRoot = async (address) => {
  reads++
  if (fail) throw new Error('RPC unavailable')
  return (address === user.rootAddress ? verified : linked) ? user.rootAddress : null
}
chain.entitlement = async () => amount
chain.ubiClaimPeriod = async () => ({ id: 'period-test', startsAt: 1000, endsAt: 86401000 })

test('health distinguishes empty entitlement, available claims, unlinked wallets and expired identities', async () => {
  assert.deepEqual(await claimHealth(user), { status: 'waiting', message: 'Your wallet link is working. No G$ is available right now; Jara will check again automatically.', nextPeriodAt: 86401000 })
  amount = parseEther('120')
  assert.equal((await claimHealth(user)).status, 'ready')
  linked = false
  assert.equal((await claimHealth(user)).status, 'reconnect')
  verified = false
  assert.equal((await claimHealth(user)).status, 'verify')
  verified = linked = true
})

test('RPC outages are unconfirmed, never interpreted as a missing link or successful claim', async () => {
  fail = true
  assert.equal((await claimHealth(user)).status, 'unknown')
  fail = false
})

test('health endpoint requires a session and returns uncached account-specific status', async () => {
  reads = 0
  session.requireUser = async () => NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  assert.equal((await route.GET()).status, 401)
  assert.equal(reads, 0)
  session.requireUser = async () => user
  const response = await route.GET()
  assert.equal(response.headers.get('cache-control'), 'no-store')
  assert.equal((await response.json()).status, 'ready')
})

test('broken-link errors remain actionable in claim and agent APIs', async () => {
  daily.runDaily = async () => { throw new WalletLinkError() }
  session.requireUser = async () => user
  const response = await route.POST()
  assert.equal(response.status, 409)
  const result = await response.json()
  assert.equal(result.code, 'wallet_link_required')
  assert.equal(result.retryable, false)
  assert.match(result.error, /reconnect daily claims/)
  assert.equal((await apiFailure(new WalletLinkError(), 'agent/run').json()).code, result.code)
})

test('hourly sweep requires a configured secret, preserves per-account failures and skips overlapping runs', async () => {
  let calls = 0
  daily.runDailyForAll = async () => { calls++; return [{ userId: 'a', ok: false, claimStatus: 'reconnect' }, { userId: 'b', ok: true, claimStatus: 'claimed' }] }
  const request = (token) => new Request('http://localhost/api/cron/claims', { method: 'POST', headers: { authorization: `Bearer ${token}` } })
  assert.equal((await cron.POST(request('wrong'))).status, 401)
  delete process.env.CRON_SECRET
  assert.equal((await cron.POST(request(''))).status, 401)
  assert.equal(calls, 0)
  process.env.CRON_SECRET = 'claim-test-secret'
  const result = await (await cron.POST(request('claim-test-secret'))).json()
  assert.equal(result.ran, 2)
  assert.equal(result.results[1].claimStatus, 'claimed')
  let release, entered
  const held = new Promise((resolve) => { release = resolve })
  const ready = new Promise((resolve) => { entered = resolve })
  const worker = withMoneyLock('cron:claims', async () => { entered(); await held })
  await ready
  try {
    const skipped = await (await cron.POST(request('claim-test-secret'))).json()
    assert.ok(skipped.skipped)
    assert.equal(calls, 1)
  } finally { release(); await worker }
})

after(async () => { (await db()).close(); rmSync(directory, { recursive: true, force: true }) })
