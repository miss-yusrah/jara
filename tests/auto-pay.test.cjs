/* eslint-disable @typescript-eslint/no-require-imports */
const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { createHash } = require('node:crypto')
const { parseEther } = require('viem')
const directory = mkdtempSync(`${tmpdir()}/jara-auto-pay-`)
Object.assign(process.env, { DATABASE_URL: `file:${directory}/test.db`, CHAIN_MODE: 'mock', TOPUP_PROVIDER: 'mock', DEMO_BILLS: 'true', GD_NGN_RATE: '1', PRICE_SPREAD_BPS: '0', TREASURY_PRIVATE_KEY: `0x${'1'.repeat(64)}`, CRON_SECRET: 'auto-pay-test-secret' })
const { db, run } = require('../src/lib/db.ts')
const users = require('../src/lib/users.ts')
const chain = require('../src/lib/chain.ts')
chain.balanceBlock = async () => undefined
const jars = require('../src/lib/jars.ts')
const bills = require('../src/lib/bills.ts')
const { checkAutoPay, runAutoPayForAll } = require('../src/lib/auto-pay.ts')
const { runDaily, lagosDay } = require('../src/lib/daily.ts')
const { MockProvider } = require('../src/lib/providers/mock.ts')
const amount = (n) => parseEther(String(n))

async function fixture(total = 1000, patch = {}) {
  let user = await users.createUser()
  await users.updateUser(user.id, { connected: true, rootAddress: `0x${createHash('sha256').update(user.id).digest('hex').slice(0, 40)}`, lastClaimDay: lagosDay() })
  user = await users.getUserById(user.id)
  await chain.mockDeposit(user.agentAddress, amount(total))
  await run('UPDATE jars SET target_ngn = 0, auto_pay = 0 WHERE user_id = ?', [user.id])
  await jars.updateJar(user.id, 'airtime', { targetNgn: 100, autoPay: true, everyDays: null, details: { phone: '08031234567', network: 'mtn' }, ...patch })
  return user
}
const count = async (user) => Number((await run("SELECT COUNT(*) AS n FROM activity WHERE user_id = ? AND type = 'pay'", [user.id])).rows[0].n)

test('external funds are allocated and paid by the lightweight sweep, without claims or AI jobs', async () => {
  const user = await fixture(0)
  await chain.mockDeposit(user.agentAddress, amount(100))
  const results = await runAutoPayForAll()
  assert.equal(results.find((r) => r.userId === user.id).payments, 1)
  assert.equal(await chain.gdBalance(user.agentAddress), 0n)
  assert.equal((await run("SELECT COUNT(*) AS n FROM activity WHERE user_id = ? AND type IN ('claim', 'ai')", [user.id])).rows[0].n, 0)
})

test('repeated minute checks and daily agent share one purchase, even with enough funds for ten', async () => {
  const user = await fixture()
  assert.equal((await checkAutoPay(user)).length, 1)
  assert.deepEqual(await checkAutoPay(user), [])
  assert.deepEqual((await runDaily(user)).paid, [])
  assert.equal(await count(user), 1)
  assert.equal(await chain.gdBalance(user.agentAddress), amount(900))
  // A changed amount/recipient must not reuse an old identity or buy again today.
  await jars.updateJar(user.id, 'airtime', { targetNgn: 200, details: { phone: '08031234568' } })
  assert.deepEqual(await checkAutoPay(user), [])
})

test('a claim immediately pays a newly full jar', async () => {
  const user = await fixture(0)
  await users.updateUser(user.id, { lastClaimDay: lagosDay(-1) })
  const result = await runDaily(await users.getUserById(user.id))
  assert.ok(result.claimed > 0n)
  assert.equal(result.paid.length, 1)
  assert.equal(await count(user), 1)
})

test('disabled, underfunded, zero-target, and unconfigured jars do not pay', async () => {
  for (const [total, patch] of [[1000, { autoPay: false }], [99, {}], [1000, { targetNgn: 0 }], [1000, { details: {} }]]) {
    const user = await fixture(total, patch)
    assert.deepEqual(await checkAutoPay(user), [])
    assert.equal(await count(user), 0)
    assert.equal(await chain.gdBalance(user.agentAddress), amount(total))
  }
})

test('full cadence jars wait until due and pay only once for the cycle', async () => {
  const user = await fixture(1000, { everyDays: 7 })
  await run('UPDATE jars SET last_paid_at = ? WHERE user_id = ? AND kind = ?', [Date.now() - 6 * 86400000, user.id, 'airtime'])
  assert.deepEqual(await checkAutoPay(user), [])
  await run('UPDATE jars SET last_paid_at = ? WHERE user_id = ? AND kind = ?', [Date.now() - 8 * 86400000, user.id, 'airtime'])
  assert.equal((await checkAutoPay(user)).length, 1)
  assert.deepEqual(await checkAutoPay(user), [])
  assert.equal(await count(user), 1)
})

test('a pending purchase across midnight resumes its saved reference, despite changed settings', async () => {
  const user = await fixture()
  const now = Date.now
  const buy = MockProvider.prototype.buyAirtime
  const status = MockProvider.prototype.getStatus
  let purchases = 0
  let reference
  MockProvider.prototype.buyAirtime = async (input) => { purchases++; reference = input.reference; return { state: 'pending', reference } }
  MockProvider.prototype.getStatus = async (ref) => { assert.equal(ref, reference); return { state: 'success', reference: ref } }
  try {
    assert.equal((await checkAutoPay(user))[0].result.pending, true)
    await jars.updateJar(user.id, 'airtime', { targetNgn: 200, details: { phone: '08031234568' } })
    Date.now = () => now() + 86400000
    const resumed = await checkAutoPay(user)
    assert.equal(resumed.length, 1)
    assert.equal(resumed[0].result.ok, true)
    assert.match(resumed[0].description, /100/)
    assert.deepEqual(await checkAutoPay(user), [])
    assert.equal(purchases, 1)
    assert.equal(await count(user), 1)
    assert.equal(await chain.gdBalance(user.agentAddress), amount(900))
  } finally { Date.now = now; MockProvider.prototype.buyAirtime = buy; MockProvider.prototype.getStatus = status }
})

test('an uncertain charge recovers once even after its jar has been debited', async () => {
  const user = await fixture(100)
  const transfer = chain.transferFromAgent
  const { TransferPendingError } = require('../src/lib/chain-outbox.ts')
  chain.transferFromAgent = async (...args) => { await transfer(...args); throw new TransferPendingError() }
  try { assert.equal((await checkAutoPay(user))[0].result.pending, true) }
  finally { chain.transferFromAgent = transfer }
  assert.equal((await checkAutoPay(user))[0].result.ok, true)
  assert.equal(await count(user), 1)
  assert.equal(await chain.gdBalance(user.agentAddress), 0n)
})

test('failed and refunded purchases are not retried on every minute tick', async () => {
  const user = await fixture(100, { details: { phone: '08000000000', network: 'mtn' } })
  assert.equal((await checkAutoPay(user))[0].result.ok, false)
  assert.deepEqual(await checkAutoPay(user), [])
  assert.equal(await count(user), 1)
  assert.equal(await chain.gdBalance(user.agentAddress), amount(100))
})

test('legacy daily identities suppress a second attempt after deployment', async () => {
  const user = await fixture()
  const prepared = await bills.prepareBill(user, { id: `auto:airtime:${lagosDay()}`, kind: 'airtime', amountNgn: 100 })
  await bills.payBill(user, prepared.action)
  await run('UPDATE jars SET last_paid_at = NULL WHERE user_id = ?', [user.id])
  assert.deepEqual(await checkAutoPay(user), [])
  assert.equal(await count(user), 1)
})

test('manual pending bills block a new automatic purchase of the same kind', async () => {
  const user = await fixture()
  const buy = MockProvider.prototype.buyAirtime
  MockProvider.prototype.buyAirtime = async ({ reference }) => ({ state: 'pending', reference })
  try {
    const prepared = await bills.prepareBill(user, { id: 'manual-pending', kind: 'airtime', amountNgn: 100 })
    await bills.payBill(user, prepared.action)
    assert.deepEqual(await checkAutoPay(user), [])
    assert.equal(await count(user), 1)
  } finally { MockProvider.prototype.buyAirtime = buy }
})

test('concurrent check waits for the next tick; it cannot spend through an active user lock', async () => {
  const user = await fixture()
  let release, ready
  const acquired = new Promise((resolve) => { ready = resolve })
  const hold = new Promise((resolve) => { release = resolve })
  const lock = jars.withUserLock(user.id, async () => { ready(); await hold })
  await acquired
  try {
    const result = await runAutoPayForAll()
    assert.equal(result.find((r) => r.userId === user.id).status, 'busy')
    assert.equal(await count(user), 0)
  } finally { release(); await lock }
  assert.equal((await checkAutoPay(user)).length, 1)
})

test('deposit and budget-move routes schedule payment after their response', async () => {
  const session = require('../src/lib/session.ts')
  const background = require('../src/lib/auto-pay-after.ts')
  const original = { requireUser: session.requireUser, scheduleAutoPay: background.scheduleAutoPay }
  const queued = []
  background.scheduleAutoPay = (id) => queued.push(id)
  try {
    const user = await fixture(0)
    session.requireUser = async () => user
    const deposit = require('../src/app/api/demo/deposit/route.ts').POST
    const response = await deposit(new Request('http://localhost/api/demo/deposit', { method: 'POST', body: JSON.stringify({ gd: 100 }) }))
    assert.equal(response.status, 200)
    assert.equal(await count(user), 0)
    assert.equal(queued.shift(), user.id)
    assert.equal((await checkAutoPay(user)).length, 1)

    const moved = await fixture(100)
    await run("UPDATE jars SET balance_wei = ? WHERE user_id = ? AND kind = 'ai'", [String(amount(100)), moved.id])
    session.requireUser = async () => moved
    const move = require('../src/app/api/jars/route.ts').POST
    const movedResponse = await move(new Request('http://localhost/api/jars', { method: 'POST', body: JSON.stringify({ action: 'move', from: 'ai', kind: 'airtime', amountGd: '100', requestId: 'move-autopay-test' }) }))
    assert.equal(movedResponse.status, 200)
    assert.equal(await count(moved), 0)
    assert.equal(queued.shift(), moved.id)
    assert.equal((await checkAutoPay(moved)).length, 1)
  } finally { session.requireUser = original.requireUser; background.scheduleAutoPay = original.scheduleAutoPay }
})

test('the minute endpoint requires the cron secret and rejects an unconfigured secret', async () => {
  const { POST } = require('../src/app/api/cron/auto-pay/route.ts')
  for (const authorization of ['', 'Bearer wrong']) {
    const response = await POST(new Request('http://localhost/api/cron/auto-pay', { method: 'POST', headers: { authorization } }))
    assert.equal(response.status, 401)
  }
  const secret = process.env.CRON_SECRET
  process.env.CRON_SECRET = ''
  try { assert.equal((await POST(new Request('http://localhost/api/cron/auto-pay', { method: 'POST', headers: { authorization: 'Bearer ' } }))).status, 401) }
  finally { process.env.CRON_SECRET = secret }
})

after(async () => { (await db()).close(); rmSync(directory, { recursive: true, force: true }) })
