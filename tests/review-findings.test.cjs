/* eslint-disable @typescript-eslint/no-require-imports */
// Regression tests for the GoodBuilders review findings:
//   JAR-06  the assistant cannot charge G$ or change payment settings without the user's approval
//   J-01    simulated and real money never mix
//   JAR-05  referral rewards pay once per verified GoodDollar identity
const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { createHash } = require('node:crypto')
const { parseEther } = require('viem')
const directory = mkdtempSync(`${tmpdir()}/jara-review-`)
const BASE_ENV = { REFERRAL_CAMPAIGN_BUDGET_GD: '100000', REFERRAL_DAILY_BUDGET_GD: '100000', DATABASE_URL: `file:${directory}/test.db`, CHAIN_MODE: 'mock', TOPUP_PROVIDER: 'mock', DEMO_BILLS: 'true', VTPASS_ENV: 'sandbox', GD_NGN_RATE: '1', PRICE_SPREAD_BPS: '0', TREASURY_PRIVATE_KEY: `0x${'1'.repeat(64)}` }
Object.assign(process.env, BASE_ENV)
delete process.env.FALCONPAY_API_KEY
const { db, run } = require('../src/lib/db.ts')
const users = require('../src/lib/users.ts')
const chain = require('../src/lib/chain.ts')
chain.balanceBlock = async () => undefined
const llm = require('../src/lib/agent/llm.ts')
const jars = require('../src/lib/jars.ts')
const spend = require('../src/lib/spend.ts')
const bills = require('../src/lib/bills.ts')
const env = require('../src/lib/env.ts')
const agent = require('../src/lib/agent/index.ts')
const approvals = require('../src/lib/agent/approvals.ts')
const jobs = require('../src/lib/agent/jobs.ts')
const rewards = require('../src/lib/rewards.ts')
const session = require('../src/lib/session.ts')
const providers = require('../src/lib/providers/index.ts')
require('../src/lib/auto-pay-after.ts').scheduleAutoPay = () => {}
const demoRoute = require('../src/app/api/demo/deposit/route.ts')
const gd = (n) => parseEther(String(n))
const rootOf = (seed) => `0x${createHash('sha256').update(seed).digest('hex').slice(0, 40)}`

async function fixture(budgets = { ai: 1000 }) {
  let user = await users.createUser()
  await users.updateUser(user.id, { connected: true, rootAddress: rootOf(user.id) })
  user = await users.getUserById(user.id)
  await chain.mockDeposit(user.agentAddress, gd(Object.values(budgets).reduce((a, b) => a + b, 0)))
  await run('UPDATE jars SET target_ngn = 0 WHERE user_id = ?', [user.id])
  for (const [kind, value] of Object.entries(budgets)) await run('UPDATE jars SET balance_wei = ? WHERE user_id = ? AND kind = ?', [String(gd(value)), user.id, kind])
  return user
}
const jar = async (user, kind) => (await jars.getJars(user.id)).find((j) => j.kind === kind)
const count = async (sql, args) => Number((await run(sql, args)).rows[0].n)

/** Make the model call one tool, then (if asked again) say something that claims success. */
async function withModel(call, fn) {
  const originals = { chat: llm.chat, reachable: llm.llmReachable }
  let calls = 0
  llm.llmReachable = async () => true
  llm.chat = async () => {
    calls++
    if (calls === 1) return { role: 'assistant', content: null, tool_calls: [{ id: 'call-1', type: 'function', function: { name: call.name, arguments: JSON.stringify(call.args) } }] }
    return { role: 'assistant', content: 'All done, I have paid and switched it on for you!' }
  }
  try { return await fn(() => calls) } finally { llm.chat = originals.chat; llm.llmReachable = originals.reachable }
}
let n = 0
const ask = (user, text) => agent.handleMessage(user.id, text, `review-message-${++n}`)

// ---------- JAR-06 ----------

test('JAR-06: use_ai_helper called by the model charges nothing until the user approves, then charges once', async () => {
  const user = await fixture()
  await withModel({ name: 'use_ai_helper', args: { tool: 'research', input: 'Inflation in Nigeria' } }, async (calls) => {
    const reply = await ask(user, 'I need help with something for school')
    assert.ok(reply.confirm, 'the reply must carry a confirmation card')
    assert.equal(reply.confirm.gd, 300)
    assert.match(reply.confirm.summary, /Research.*Inflation in Nigeria/)
    assert.doesNotMatch(reply.text, /All done/, 'the model does not get to claim it happened')
    assert.equal(calls(), 1, 'the helper itself was never invoked')
    assert.equal(await chain.gdBalance(user.agentAddress), gd(1000))
    assert.equal(await count('SELECT COUNT(*) AS n FROM payments WHERE user_id = ?', [user.id]), 0)
    assert.equal(await count('SELECT COUNT(*) AS n FROM ai_runs WHERE user_id = ?', [user.id]), 0)

    const done = await agent.resolvePending(user.id, true, reply.confirm.id)
    assert.match(done.text, /charged G\$ 300/)
    assert.equal(await chain.gdBalance(user.agentAddress), gd(700))
    // A second tap replays the saved result: no second answer, no second charge.
    assert.deepEqual((await agent.resolvePending(user.id, true, reply.confirm.id)).text, done.text)
    assert.equal(await chain.gdBalance(user.agentAddress), gd(700))
    assert.equal(await count('SELECT COUNT(*) AS n FROM ai_runs WHERE user_id = ?', [user.id]), 1)
  })
})

test('JAR-06: set_jar cannot switch on auto-pay or change the recipient without approval', async () => {
  const user = await fixture({ airtime: 500 })
  await run("UPDATE jars SET target_ngn = 500, details = ? WHERE user_id = ? AND kind = 'airtime'", [JSON.stringify({ phone: '08031234567', network: 'mtn' }), user.id])
  await withModel({ name: 'set_jar', args: { jar: 'airtime', auto_pay: true, phone: '08021112222' } }, async () => {
    const reply = await ask(user, 'What is in my airtime jar and how does it work?')
    assert.ok(reply.confirm)
    assert.match(reply.confirm.summary, /auto-pay ON/)
    assert.match(reply.confirm.summary, /0802 111 2222|08021112222/)
    let saved = await jar(user, 'airtime')
    assert.equal(saved.autoPay, false)
    assert.equal(saved.details.phone, '08031234567')

    await agent.resolvePending(user.id, true, reply.confirm.id)
    saved = await jar(user, 'airtime')
    assert.equal(saved.autoPay, true)
    assert.equal(saved.details.phone, '08021112222')
  })
})

test('JAR-06: cancelling, or a stale or expired request, changes nothing', async () => {
  const user = await fixture({ airtime: 500 })
  await withModel({ name: 'set_jar', args: { jar: 'airtime', target_ngn: 900 } }, async () => {
    const first = await ask(user, 'Tell me about my jars please')
    assert.match((await agent.resolvePending(user.id, false, first.confirm.id)).text, /cancelled/i)
    assert.match((await agent.resolvePending(user.id, true, first.confirm.id)).text, /cancelled/i)
    assert.equal((await jar(user, 'airtime')).targetNgn, 0)
  })
  await withModel({ name: 'set_jar', args: { jar: 'airtime', target_ngn: 900 } }, async () => {
    const stale = await ask(user, 'Tell me about my airtime jar')
    await withModel({ name: 'set_jar', args: { jar: 'data', target_ngn: 700 } }, async () => {
      const current = await ask(user, 'And what about my data jar')
      // The old button names the old request, which the newer one replaced.
      assert.match((await agent.resolvePending(user.id, true, stale.confirm.id)).text, /cancelled/i)
      assert.equal((await jar(user, 'airtime')).targetNgn, 0)
      await run('UPDATE approvals SET created_at = ? WHERE id = ?', [Date.now() - approvals.APPROVAL_TTL_MS - 1000, current.confirm.id])
      assert.match((await agent.resolvePending(user.id, true, current.confirm.id)).text, /expired/i)
      assert.equal((await jar(user, 'data')).targetNgn, 0)
    })
  })
})

test('JAR-06: only an unambiguous yes from the user approves; a new instruction does not', async () => {
  const user = await fixture({ airtime: 500 })
  await withModel({ name: 'set_jar', args: { jar: 'airtime', target_ngn: 900 } }, async () => {
    const reply = await ask(user, 'Explain my airtime jar to me')
    assert.ok(reply.confirm)
  })
  // Starts with "ok"/"send" but is a different instruction: it must not count as consent.
  await withModel({ name: 'get_jars', args: {} }, async () => { await ask(user, 'ok send me my jar balances instead') })
  assert.equal((await jar(user, 'airtime')).targetNgn, 0)
  assert.ok(await approvals.pendingApproval(user.id), 'still waiting for a real answer')
  const yes = await ask(user, 'Yes please')
  assert.match(yes.text, /Done/)
  assert.equal((await jar(user, 'airtime')).targetNgn, 900)
})

test('JAR-06: moving budget and switching on paid jobs also wait; switching spending off does not', async () => {
  const user = await fixture({ ai: 200 })
  await chain.mockDeposit(user.agentAddress, gd(300))
  await withModel({ name: 'move_to_jar', args: { jar: 'airtime', amount_ngn: 300 } }, async () => {
    const reply = await ask(user, 'How are my jars looking today?')
    assert.ok(reply.confirm)
    assert.equal((await jar(user, 'airtime')).balanceWei, 0n)
    await agent.resolvePending(user.id, true, reply.confirm.id)
    assert.equal((await jar(user, 'airtime')).balanceWei, gd(300))
  })
  await withModel({ name: 'set_exam_prep', args: { on: true, exam: 'JAMB', subjects: ['Biology'], exam_date: new Date(Date.now() + 30 * 86_400_000).toISOString().slice(0, 10) } }, async () => {
    const reply = await ask(user, 'I have JAMB coming up')
    assert.ok(reply.confirm)
    assert.equal(reply.confirm.gd, jobs.DRILL_PRICE_GD)
    assert.equal((await jobs.getJobs(user.id)).examOn, false)
    assert.equal(await count('SELECT COUNT(*) AS n FROM payments WHERE user_id = ?', [user.id]), 0)
  })
  await withModel({ name: 'set_opportunity_scout', args: { on: true, interests: 'engineering scholarships' } }, async () => {
    const reply = await ask(user, 'I am looking for scholarships')
    assert.ok(reply.confirm)
    assert.equal((await jobs.getJobs(user.id)).scoutOn, false)
  })
  await jobs.saveJobs(user.id, { scoutOn: true, scoutInterests: 'engineering scholarships' })
  await withModel({ name: 'set_opportunity_scout', args: { on: false } }, async () => {
    const reply = await ask(user, 'Stop the scholarship search')
    assert.equal(reply.confirm, undefined)
    assert.equal((await jobs.getJobs(user.id)).scoutOn, false)
  })
})

test('JAR-06: the confirmation survives a reload and a bill replaces a waiting request', async () => {
  const user = await fixture({ airtime: 1000 })
  await withModel({ name: 'set_jar', args: { jar: 'airtime', target_ngn: 900 } }, async () => {
    const reply = await ask(user, 'Tell me about airtime')
    const card = await agent.pendingConfirm(await users.getUserById(user.id))
    assert.equal(card.id, reply.confirm.id)
    assert.equal(card.summary, reply.confirm.summary)
  })
  const bill = await ask(user, '200 airtime to 08031234567')
  assert.ok(bill.confirm)
  assert.equal(await approvals.pendingApproval(user.id), null)
  assert.equal((await agent.pendingConfirm(await users.getUserById(user.id))).id, bill.confirm.id)
  await agent.resolvePending(user.id, false, bill.confirm.id)
})

// ---------- J-01 ----------

function withEnv(values, fn) {
  const before = {}
  for (const key of Object.keys(values)) { before[key] = process.env[key]; if (values[key] === undefined) delete process.env[key]; else process.env[key] = values[key] }
  const restore = () => { for (const key of Object.keys(before)) { if (before[key] === undefined) delete process.env[key]; else process.env[key] = before[key] } }
  let result
  try { result = fn() } catch (err) { restore(); throw err }
  return result instanceof Promise ? result.finally(restore) : (restore(), result)
}

test('J-01: every pairing of simulated and real money is refused', () => {
  const mode = (values) => withEnv({ DEMO_BILLS: undefined, FALCONPAY_API_KEY: undefined, VTPASS_ENV: 'sandbox', ...values }, () => {
    const cfg = env.serverConfig()
    return { mode: cfg.moneyMode, bills: cfg.billsLive, demoFunds: env.demoFundsAllowed() }
  })
  // Demo G$ with a live provider (fake money spending Jara's real balance).
  assert.deepEqual(mode({ CHAIN_MODE: 'mock', TOPUP_PROVIDER: 'vtpass', VTPASS_ENV: 'live' }), { mode: 'mismatch', bills: false, demoFunds: false })
  assert.deepEqual(mode({ CHAIN_MODE: 'mock', TOPUP_PROVIDER: 'falconpay', FALCONPAY_API_KEY: 'sk_live_x' }), { mode: 'mismatch', bills: false, demoFunds: false })
  // Real G$ with a simulated provider (real money taken, nothing delivered).
  assert.deepEqual(mode({ CHAIN_MODE: 'celo', TOPUP_PROVIDER: 'vtpass', VTPASS_ENV: 'sandbox' }), { mode: 'mismatch', bills: false, demoFunds: false })
  assert.deepEqual(mode({ CHAIN_MODE: 'celo', TOPUP_PROVIDER: 'falconpay', FALCONPAY_API_KEY: 'sk_test_x' }), { mode: 'mismatch', bills: false, demoFunds: false })
  assert.deepEqual(mode({ CHAIN_MODE: 'celo', TOPUP_PROVIDER: 'mock', DEMO_BILLS: 'true' }), { mode: 'mismatch', bills: false, demoFunds: false })
  // The consistent configurations.
  assert.deepEqual(mode({ CHAIN_MODE: 'celo', TOPUP_PROVIDER: 'vtpass', VTPASS_ENV: 'live' }), { mode: 'live', bills: true, demoFunds: false })
  assert.deepEqual(mode({ CHAIN_MODE: 'celo', TOPUP_PROVIDER: 'falconpay', FALCONPAY_API_KEY: 'sk_live_x' }), { mode: 'live', bills: true, demoFunds: false })
  assert.deepEqual(mode({ CHAIN_MODE: 'celo', TOPUP_PROVIDER: 'mock' }), { mode: 'bills-off', bills: false, demoFunds: false })
  assert.deepEqual(mode({ CHAIN_MODE: 'mock', TOPUP_PROVIDER: 'vtpass', VTPASS_ENV: 'sandbox' }), { mode: 'demo', bills: true, demoFunds: true })
  assert.deepEqual(mode({ CHAIN_MODE: 'mock', TOPUP_PROVIDER: 'mock', DEMO_BILLS: 'true' }), { mode: 'demo', bills: true, demoFunds: true })
  assert.deepEqual(mode({ CHAIN_MODE: 'mock', TOPUP_PROVIDER: 'mock' }), { mode: 'demo', bills: false, demoFunds: true })
})

test('J-01: demo G$ cannot be added, and no bill is charged or sent, while a live provider is configured', async () => {
  const user = await fixture({ airtime: 1000 })
  const prepared = await bills.prepareBill(user, { kind: 'airtime', amountNgn: 100, network: 'mtn', phone: '08031234567', id: 'j01-prepared-in-demo' })
  assert.ok(!('error' in prepared))
  const originalSession = session.requireUser
  const originalFetch = global.fetch
  session.requireUser = async () => user
  let providerCalls = 0
  global.fetch = async () => { providerCalls++; throw new Error('the live provider must never be called') }
  try {
    await withEnv({ TOPUP_PROVIDER: 'vtpass', VTPASS_ENV: 'live' }, async () => {
      const response = await demoRoute.POST(new Request('http://localhost/api/demo/deposit', { method: 'POST', body: JSON.stringify({ gd: 5000 }) }))
      assert.equal(response.status, 409)
      assert.equal(await chain.gdBalance(user.agentAddress), gd(1000))
      assert.ok('error' in await bills.prepareBill(user, { kind: 'airtime', amountNgn: 100, network: 'mtn', phone: '08031234567' }))
      // A bill prepared before the mode changed is refused at the purchase boundary too.
      const result = await bills.payBill(user, prepared.action)
      assert.equal(result.ok, false)
      assert.match(result.message, /Nothing was charged/)
    })
    assert.equal(providerCalls, 0)
    assert.equal(await chain.gdBalance(user.agentAddress), gd(1000))
    assert.equal(await count('SELECT COUNT(*) AS n FROM payments WHERE user_id = ?', [user.id]), 0)
  } finally { session.requireUser = originalSession; global.fetch = originalFetch }
})

test('J-01: a purchase already charged when the mode changes is refunded, never delivered across modes', async () => {
  const user = await fixture({ airtime: 1000 })
  const prepared = await bills.prepareBill(user, { kind: 'airtime', amountNgn: 100, network: 'mtn', phone: '08031234567', id: 'j01-mid-flight' })
  const charge = spend.spendGd
  const mock = providers.getProviderByName('mock')
  const buy = mock.buyAirtime
  let delivered = 0
  mock.buyAirtime = async (...args) => { delivered++; return buy.apply(mock, args) }
  const before = { TOPUP_PROVIDER: process.env.TOPUP_PROVIDER, VTPASS_ENV: process.env.VTPASS_ENV }
  spend.spendGd = async (...args) => {
    const paid = await charge(...args)
    Object.assign(process.env, { TOPUP_PROVIDER: 'vtpass', VTPASS_ENV: 'live' }) // an operator flips the provider mid-purchase
    return paid
  }
  try {
    const result = await bills.payBill(user, prepared.action)
    assert.equal(result.ok, false)
    assert.match(result.message, /refund is confirmed/)
    assert.equal(delivered, 0)
    assert.equal(await chain.gdBalance(user.agentAddress), gd(1000))
  } finally { spend.spendGd = charge; mock.buyAirtime = buy; Object.assign(process.env, before) }
})

// ---------- JAR-05 ----------

async function referred(referrer, root, name) {
  const account = await users.createUser({ name, referredBy: referrer.id })
  await users.updateUser(account.id, { connected: true, rootAddress: root })
  return users.getUserById(account.id)
}
const referralGd = async (user) => Number((await run("SELECT COALESCE(SUM(amount_gd), 0) AS n FROM rewards_paid WHERE user_id = ? AND reward_key LIKE 'referral-%'", [user.id])).rows[0].n)

test('JAR-05: several accounts linked to one verified identity earn a single referral reward', async () => {
  const referrer = await fixture()
  const person = rootOf('one-person')
  await referred(referrer, person, 'First account')
  await referred(referrer, person, 'Second account')
  await referred(referrer, person.toUpperCase().replace('0X', '0x'), 'Third account')
  await rewards.collectRewards(referrer)
  assert.equal(await referralGd(referrer), 1000)
  await referred(referrer, person, 'Fourth account, later')
  await rewards.collectRewards(referrer)
  assert.equal(await referralGd(referrer), 1000)
  assert.equal(await chain.gdBalance(referrer.agentAddress), gd(2000))
  // A different verified person still counts.
  await referred(referrer, rootOf('another-person'), 'Someone else')
  await rewards.collectRewards(referrer)
  assert.equal(await referralGd(referrer), 2000)
})

test('JAR-05: one identity pays one referrer only, and never its own owner', async () => {
  const first = await fixture()
  const second = await fixture()
  const person = rootOf('shared-between-referrers')
  await referred(first, person, 'Via the first link')
  await referred(second, person, 'Via the second link')
  await rewards.collectRewards(first)
  await rewards.collectRewards(second)
  assert.equal(await referralGd(first), 1000)
  assert.equal(await referralGd(second), 0)
  // A second account on the referrer's own identity is not a new person.
  const selfish = await fixture()
  await referred(selfish, selfish.rootAddress, 'My other account')
  await rewards.collectRewards(selfish)
  assert.equal(await referralGd(selfish), 0)
})

test('JAR-05: identities already rewarded under the old per-account key are not paid again', async () => {
  const referrer = await fixture()
  const person = rootOf('paid-before-the-fix')
  const old = await referred(referrer, person, 'Rewarded earlier')
  await run('INSERT INTO rewards_paid (user_id, reward_key, amount_gd, created_at) VALUES (?, ?, 1000, ?)', [referrer.id, `referral-${old.id}`, Date.now()])
  // The same backfill the app runs when it starts.
  await run(`INSERT OR IGNORE INTO referral_identities (root_address, referrer_id, referred_user_id, created_at)
    SELECT lower(u.root_address), r.user_id, u.id, MIN(r.created_at) FROM rewards_paid r JOIN users u ON u.id = substr(r.reward_key, 10)
    WHERE r.reward_key LIKE 'referral-u\\_%' ESCAPE '\\' AND u.root_address IS NOT NULL GROUP BY lower(u.root_address)`)
  await referred(referrer, person, 'Same person, new account')
  await rewards.collectRewards(referrer)
  assert.equal(await referralGd(referrer), 1000)
  assert.equal(await chain.gdBalance(referrer.agentAddress), gd(1000))
})

test('JAR-05: on Celo the referred account must still resolve to that verified identity', async () => {
  const referrer = await fixture()
  const person = rootOf('unlinked-on-chain')
  const account = await referred(referrer, person, 'No longer linked')
  const originals = { whitelistedRoot: chain.whitelistedRoot, sendGdFromTreasury: chain.sendGdFromTreasury, gdBalance: chain.gdBalance, gdAllowance: chain.gdAllowance }
  let linked = false
  let sent = 0
  chain.whitelistedRoot = async (address) => address === referrer.agentAddress ? referrer.rootAddress : address === account.agentAddress && linked ? person : null
  chain.sendGdFromTreasury = async () => { sent++; return `0x${'a'.repeat(64)}` }
  chain.gdBalance = async () => 0n
  chain.gdAllowance = async () => 0n
  process.env.CHAIN_MODE = 'celo'
  try {
    await rewards.collectRewards(referrer)
    assert.equal(await referralGd(referrer), 0)
    assert.equal(sent, 0)
    linked = true
    await rewards.collectRewards(referrer)
    assert.equal(await referralGd(referrer), 1000)
    assert.equal(sent, 1)
  } finally { Object.assign(chain, originals); process.env.CHAIN_MODE = 'mock' }
})

after(async () => { (await db()).close(); rmSync(directory, { recursive: true, force: true }) })
