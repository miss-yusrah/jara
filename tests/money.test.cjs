/* eslint-disable @typescript-eslint/no-require-imports */
const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const { parseEther } = require('viem')
const directory = mkdtempSync(path.join(tmpdir(), 'jara-money-'))
process.env.DATABASE_URL = `file:${directory}/test.db`
process.env.CHAIN_MODE = 'mock'
process.env.TOPUP_PROVIDER = 'mock'
process.env.DEMO_BILLS = 'true'
process.env.GD_NGN_RATE = '1'
process.env.PRICE_SPREAD_BPS = '0'
process.env.TREASURY_PRIVATE_KEY = `0x${'1'.repeat(64)}`
const { db, run, atomic } = require('../src/lib/db.ts')
const users = require('../src/lib/users.ts')
const chain = require('../src/lib/chain.ts')
chain.balanceBlock = async () => undefined // No live RPC in these ledger tests.
const jars = require('../src/lib/jars.ts')
const spend = require('../src/lib/spend.ts')
const bills = require('../src/lib/bills.ts')
const { moneyRequest } = require('../src/lib/money-request.ts')
const { TransferPendingError } = require('../src/lib/chain-outbox.ts')
const { createHash } = require('node:crypto')
const amount = (n) => parseEther(String(n))

async function fixture(budgets = { ai: 1000 }, total = Object.values(budgets).reduce((a, b) => a + b, 0)) {
  let user = await users.createUser()
  await users.updateUser(user.id, { connected: true, rootAddress: `0x${createHash('sha256').update(user.id).digest('hex').slice(0, 40)}` })
  user = await users.getUserById(user.id)
  await chain.mockDeposit(user.agentAddress, amount(total))
  await run('UPDATE jars SET target_ngn = 0 WHERE user_id = ?', [user.id])
  for (const [kind, value] of Object.entries(budgets)) await run('UPDATE jars SET balance_wei = ? WHERE user_id = ? AND kind = ?', [String(amount(value)), user.id, kind])
  return user
}
async function balance(user, kind) { return (await jars.getJars(user.id)).find((j) => j.kind === kind).balanceWei }
async function bill(user, id, phone = '08031234567') {
  const prepared = await bills.prepareBill(user, { kind: 'airtime', amountNgn: 100, network: 'mtn', phone, id })
  assert.ok(!('error' in prepared), JSON.stringify(prepared))
  return prepared.action
}

test('jar spending cannot borrow from another budget', async () => {
  const user = await fixture({ ai: 50, light: 950 })
  await assert.rejects(spend.spendGd(user, amount(100), { id: `${user.id}:strict`, jar: 'ai' }), /other jars are protected/)
  assert.equal(await chain.gdBalance(user.agentAddress), amount(1000))
  assert.equal(await balance(user, 'light'), amount(950))
  assert.equal(await balance(user, 'ai'), amount(50))
})

test('retry charges one time; changing an existing payment amount is rejected', async () => {
  const user = await fixture()
  const request = { id: `${user.id}:once`, jar: 'ai' }
  const first = await spend.spendGd(user, amount(100), request)
  assert.deepEqual(await spend.spendGd(user, amount(100), request), first)
  await assert.rejects(spend.spendGd(user, amount(101), request), /original amount/)
  assert.equal(await chain.gdBalance(user.agentAddress), amount(900))
  assert.equal(await balance(user, 'ai'), amount(900))
})

test('lost transfer response remains reserved and replay recovers the same hash', async () => {
  const user = await fixture()
  const original = chain.transferFromAgent
  chain.transferFromAgent = async (...args) => { await original(...args); throw new TransferPendingError() }
  const request = { id: `${user.id}:lost`, jar: 'ai' }
  try { await assert.rejects(spend.spendGd(user, amount(100), request), TransferPendingError) }
  finally { chain.transferFromAgent = original }
  assert.equal((await run('SELECT status FROM payments WHERE id = ?', [request.id])).rows[0].status, 'reserved')
  await jars.syncJars(user)
  assert.equal(await balance(user, 'ai'), amount(900))
  await spend.spendGd(user, amount(100), request)
  assert.equal(await chain.gdBalance(user.agentAddress), amount(900))
  assert.equal(await balance(user, 'ai'), amount(900))
})

test('known transfer failure restores the reservation, but never records paid', async () => {
  const user = await fixture()
  const original = chain.transferFromAgent
  chain.transferFromAgent = async () => { throw new Error('rejected before signing') }
  const request = { id: `${user.id}:fail`, jar: 'ai' }
  try { await assert.rejects(spend.spendGd(user, amount(100), request), /rejected/) }
  finally { chain.transferFromAgent = original }
  assert.equal(await balance(user, 'ai'), amount(1000))
  assert.equal((await run('SELECT status FROM payments WHERE id = ?', [request.id])).rows[0].status, 'failed')
})

test('refund failure stays pending; recovery returns funds once', async () => {
  const user = await fixture({ airtime: 1000 })
  const action = await bill(user, 'refund-test', '08000000000')
  const original = chain.sendGdFromTreasury
  chain.sendGdFromTreasury = async () => { throw new Error('refund RPC unavailable') }
  try {
    const result = await bills.payBill(user, action)
    assert.equal(result.pending, true)
    assert.match(result.message, /refund is still pending/)
  } finally { chain.sendGdFromTreasury = original }
  assert.equal((await run("SELECT COUNT(*) AS n FROM activity WHERE user_id = ? AND type = 'refund'", [user.id])).rows[0].n, 0)
  assert.equal(await chain.gdBalance(user.agentAddress), amount(900))
  const result = await bills.payBill(user, action)
  assert.equal(result.ok, false)
  assert.match(result.message, /refund is confirmed/)
  await bills.payBill(user, action)
  assert.equal(await chain.gdBalance(user.agentAddress), amount(1000))
  assert.equal(await balance(user, 'airtime'), amount(1000))
  assert.equal((await run("SELECT COUNT(*) AS n FROM activity WHERE user_id = ? AND type = 'refund'", [user.id])).rows[0].n, 1)
})

test('duplicate bill confirmations purchase once and replay the saved result', async () => {
  const user = await fixture({ airtime: 1000 })
  const action = await bill(user, 'bill-once')
  const first = await bills.payBill(user, action)
  assert.equal(first.ok, true)
  assert.deepEqual(await bills.payBill(user, action), first)
  assert.equal(await chain.gdBalance(user.agentAddress), amount(900))
  assert.equal((await run("SELECT COUNT(*) AS n FROM activity WHERE user_id = ? AND type = 'pay'", [user.id])).rows[0].n, 1)
})

test('provider not_found never triggers a speculative refund or second purchase', async () => {
  const user = await fixture({ airtime: 1000 })
  const action = await bill(user, 'provider-missing', '201000000000')
  const first = await bills.payBill(user, action)
  assert.equal(first.pending, true)
  globalThis.__mockTopups.clear() // provider lost its record / restart
  const second = await bills.payBill(user, action)
  assert.equal(second.pending, true)
  assert.equal(await chain.gdBalance(user.agentAddress), amount(900))
  assert.equal((await run("SELECT COUNT(*) AS n FROM activity WHERE user_id = ? AND type = 'refund'", [user.id])).rows[0].n, 0)
})

test('explicit budget move is atomic and idempotent without token movement', async () => {
  const user = await fixture({ ai: 100, light: 900 })
  await jars.reallocateJar(user, 'light', 'ai', amount(200), 'budget-move-1')
  await jars.reallocateJar(user, 'light', 'ai', amount(200), 'budget-move-1')
  assert.equal(await balance(user, 'ai'), amount(300))
  assert.equal(await balance(user, 'light'), amount(700))
  assert.equal(await chain.gdBalance(user.agentAddress), amount(1000))
  await assert.rejects(jars.reallocateJar(user, 'light', 'ai', amount(800), 'budget-move-2'), /Not enough/)
  assert.equal(await balance(user, 'light'), amount(700))
})

test('withdrawal retry transfers the original amount once', async () => {
  const user = await fixture()
  const initial = await chain.gdBalance(user.rootAddress)
  await jars.withUserLock(user.id, () => spend.withdrawToWallet(user, 'withdraw-once'))
  await jars.withUserLock(user.id, () => spend.withdrawToWallet(user, 'withdraw-once'))
  assert.equal(await chain.gdBalance(user.agentAddress), 0n)
  assert.equal(await chain.gdBalance(user.rootAddress), initial + amount(1000))
})

test('reusing a request ID with different input is rejected', async () => {
  const user = await fixture()
  await moneyRequest(user.id, 'request-test', { amount: 1 })
  await assert.rejects(moneyRequest(user.id, 'request-test', { amount: 2 }), /different request/)
})

test('live wallet link is checked again even for a connected session', async () => {
  const user = await fixture()
  const original = chain.whitelistedRoot
  chain.whitelistedRoot = async () => `0x${'3'.repeat(40)}`
  process.env.CHAIN_MODE = 'celo'
  try { await assert.rejects(spend.spendGd(user, amount(100), { id: `${user.id}:unauthorized`, jar: 'ai' }), /wallet link has changed/) }
  finally { process.env.CHAIN_MODE = 'mock'; chain.whitelistedRoot = original }
  assert.equal(await balance(user, 'ai'), amount(1000))
})

test('a purchase cannot combine two individually insufficient wallets', async () => {
  const user = await fixture({ ai: 700 }, 500)
  const originals = { gdBalance: chain.gdBalance, gdAllowance: chain.gdAllowance, whitelistedRoot: chain.whitelistedRoot }
  chain.whitelistedRoot = async () => user.rootAddress
  chain.gdBalance = async () => amount(500)
  chain.gdAllowance = async () => amount(500)
  process.env.CHAIN_MODE = 'celo'
  try { await assert.rejects(spend.spendGd(user, amount(700), { id: `${user.id}:split`, jar: 'ai' }), /One wallet must cover/) }
  finally { process.env.CHAIN_MODE = 'mock'; Object.assign(chain, originals) }
})

test('competing workers cannot both acquire the same user lock', async () => {
  const user = await fixture()
  let release
  let acquired
  const ready = new Promise((resolve) => { acquired = resolve })
  const hold = new Promise((resolve) => { release = resolve })
  const first = jars.withUserLock(user.id, async () => { acquired(); await hold })
  await ready
  await assert.rejects(jars.withUserLock(user.id, async () => {}), /Another operation/)
  release()
  await first
})

test('an expired worker cannot write after its lease has been taken over', async () => {
  const user = await fixture()
  await assert.rejects(jars.withUserLock(user.id, async () => {
    await (await db()).execute({ sql: 'UPDATE money_locks SET owner = ? WHERE id = ?', args: ['replacement-worker', `user:${user.id}`] })
    await run('UPDATE jars SET balance_wei = ? WHERE user_id = ?', ['0', user.id])
  }), /lost its lock/)
  assert.equal(await balance(user, 'ai'), amount(1000))
})

test('multi-row ledger changes roll back together', async () => {
  const user = await fixture({ ai: 100, light: 900 })
  await assert.rejects(atomic(async (tx) => {
    await tx.execute({ sql: "UPDATE jars SET balance_wei = '0' WHERE user_id = ? AND kind = 'light'", args: [user.id] })
    throw new Error('simulated crash')
  }), /simulated crash/)
  assert.equal(await balance(user, 'light'), amount(900))
})

test('wallet-source refund returns tokens to the payer without inventing renewed allowance', async () => {
  const user = await fixture({ ai: 1000 }, 0)
  const names = ['gdBalance', 'gdAllowance', 'whitelistedRoot', 'pullGdFromWallet', 'sendGdFromTreasury']
  const originals = Object.fromEntries(names.map((name) => [name, chain[name]]))
  let wallet = amount(1000)
  let allowance = amount(1000)
  let pulls = 0
  const hash = `0x${'4'.repeat(64)}`
  chain.whitelistedRoot = async () => user.rootAddress
  chain.gdBalance = async (address) => address === user.rootAddress ? wallet : 0n
  chain.gdAllowance = async () => allowance
  chain.pullGdFromWallet = async (from, value) => { assert.equal(from, user.rootAddress); pulls++; wallet -= value; allowance -= value; return { hash, feeWei: 0n } }
  chain.sendGdFromTreasury = async (to, value) => { assert.equal(to, user.rootAddress); wallet += value; return hash }
  process.env.CHAIN_MODE = 'celo'
  try {
    const id = `${user.id}:wallet-payment`
    await spend.spendGd(user, amount(100), { id, jar: 'ai' })
    await spend.refundPayment(user, id)
    await spend.refundPayment(user, id)
    assert.equal(pulls, 1)
    assert.equal(wallet, amount(1000))
    assert.equal(allowance, amount(900))
    assert.equal(await balance(user, 'ai'), amount(900))
  } finally { process.env.CHAIN_MODE = 'mock'; Object.assign(chain, originals) }
})

test('one wallet cannot back two Jara accounts', async () => {
  const first = await fixture()
  const second = await fixture()
  await users.updateUser(second.id, { rootAddress: first.rootAddress })
  const { bindWallet } = require('../src/lib/wallet-authorization.ts')
  await assert.rejects(bindWallet(first.id, first.rootAddress), /already has a Jara account/)
})

test('connected users cannot replace their wallet through onboarding', async () => {
  const user = await fixture()
  const session = require('../src/lib/session.ts')
  const original = session.requireUser
  session.requireUser = async () => user
  try {
    const { POST } = require('../src/app/api/onboard/route.ts')
    const response = await POST(new Request('http://localhost/api/onboard', { method: 'POST', body: JSON.stringify({ action: 'root', address: `0x${'8'.repeat(40)}` }) }))
    assert.equal(response.status, 409)
    assert.equal((await users.getUserById(user.id)).rootAddress, user.rootAddress)
  } finally { session.requireUser = original }
})

test('AI preserves its answer through an uncertain charge and records paid only after confirmation', async () => {
  const user = await fixture()
  const ai = require('../src/lib/ai-tools.ts')
  const llm = require('../src/lib/agent/llm.ts')
  const reachable = llm.llmReachable
  const transfer = chain.transferFromAgent
  llm.llmReachable = async () => true
  let generated = 0
  const job = { requestId: 'ai-timeout', tool: 'research', title: 'Test answer', input: 'Explain budgeting', priceGd: 100, produce: async () => { generated++; return 'A saved answer' } }
  chain.transferFromAgent = async (...args) => { await transfer(...args); throw new TransferPendingError() }
  try {
    const first = await ai.runPaidJob(user, job)
    assert.equal(first.ok, false)
    assert.equal((await run('SELECT COUNT(*) AS n FROM ai_runs WHERE user_id = ?', [user.id])).rows[0].n, 0)
    assert.equal((await run("SELECT COUNT(*) AS n FROM activity WHERE user_id = ? AND type = 'ai'", [user.id])).rows[0].n, 0)
    chain.transferFromAgent = transfer
    const second = await ai.runPaidJob(user, job)
    assert.equal(second.ok, true)
    assert.equal(second.output, 'A saved answer')
    await ai.runPaidJob(user, job)
    assert.equal(generated, 1)
    assert.equal(await chain.gdBalance(user.agentAddress), amount(900))
    assert.equal((await run('SELECT COUNT(*) AS n FROM ai_runs WHERE user_id = ?', [user.id])).rows[0].n, 1)
  } finally { llm.llmReachable = reachable; chain.transferFromAgent = transfer }
})

test('an incomplete AI stream is never charged', async () => {
  const user = await fixture()
  const llm = require('../src/lib/agent/llm.ts')
  const originals = { llmReachable: llm.llmReachable, chatStream: llm.chatStream }
  llm.llmReachable = async () => true
  llm.chatStream = async function* () { yield 'Partial answer'; throw new Error('stream interrupted') }
  try {
    const { sendChat } = require('../src/lib/ai-chat.ts')
    const events = []
    for await (const event of sendChat(user, { requestId: 'partial-stream', tool: 'research', text: 'Explain budgets' })) events.push(event)
    assert.equal(events.at(-1).t, 'error')
    assert.equal(await chain.gdBalance(user.agentAddress), amount(1000))
    assert.equal((await run('SELECT COUNT(*) AS n FROM payments WHERE user_id = ?', [user.id])).rows[0].n, 0)
  } finally { Object.assign(llm, originals) }
})

test('a stale bill button cannot confirm a newly prepared bill', async () => {
  const user = await fixture({ airtime: 1000 })
  const old = await bill(user, 'old-bill')
  const current = await bill(user, 'new-bill')
  await users.updateUser(user.id, { pending: current })
  const { resolvePending } = require('../src/lib/agent/index.ts')
  const result = await resolvePending(user.id, true, old.id)
  assert.match(result.text, /does not match/)
  assert.equal(await chain.gdBalance(user.agentAddress), amount(1000))
})

test('daily claim retries, including a stale user object and force, cannot mint or log twice', async () => {
  const user = await fixture({}, 0)
  const { runDaily } = require('../src/lib/daily.ts')
  const first = await runDaily(user)
  assert.ok(first.claimed > 0n)
  const second = await runDaily(user, { force: true })
  assert.equal(second.claimed, 0n)
  assert.equal(await chain.gdBalance(user.agentAddress), first.claimed)
  assert.equal((await run("SELECT COUNT(*) AS n FROM activity WHERE user_id = ? AND type = 'claim'", [user.id])).rows[0].n, 1)
})

test('reward payout with a lost receipt is recovered without paying twice', async () => {
  const user = await fixture()
  const { collectRewards } = require('../src/lib/rewards.ts')
  await users.logActivity(user.id, { type: 'pay', title: 'A confirmed bill', status: 'done' })
  const original = chain.sendGdFromTreasury
  chain.sendGdFromTreasury = async (...args) => { await original(...args); throw new TransferPendingError() }
  try { assert.equal((await collectRewards(user)).length, 0) }
  finally { chain.sendGdFromTreasury = original }
  assert.equal((await run('SELECT COUNT(*) AS n FROM rewards_paid WHERE user_id = ?', [user.id])).rows[0].n, 0)
  assert.equal((await collectRewards(user)).length, 1)
  assert.equal((await collectRewards(user)).length, 0)
  assert.equal(await chain.gdBalance(user.agentAddress), amount(1300))
})

test('chat retries return the saved answer and charge exactly once', async () => {
  const user = await fixture()
  const llm = require('../src/lib/agent/llm.ts')
  const originals = { llmReachable: llm.llmReachable, chatStream: llm.chatStream }
  llm.llmReachable = async () => true
  let generated = 0
  llm.chatStream = async function* () { generated++; yield 'A complete answer' }
  try {
    const { sendChat } = require('../src/lib/ai-chat.ts')
    const input = { requestId: 'chat-once', tool: 'research', text: 'Explain budgets' }
    const first = []
    for await (const event of sendChat(user, input)) first.push(event)
    const second = []
    for await (const event of sendChat(user, input)) second.push(event)
    assert.equal(first.at(-1).t, 'done')
    assert.deepEqual(first.at(-1), second.at(-1))
    assert.equal(generated, 1)
    assert.equal(await chain.gdBalance(user.agentAddress), amount(700))
    assert.equal((await run('SELECT COUNT(*) AS n FROM ai_runs WHERE user_id = ?', [user.id])).rows[0].n, 1)
  } finally { Object.assign(llm, originals) }
})

test('negative moves cannot corrupt a jar, and external balance drops cap displayed allocations', async () => {
  const user = await fixture({ ai: 100, light: 900 })
  await assert.rejects(jars.moveToJar(user, 'ai', -100), /positive amount/)
  await run('UPDATE mock_balances SET wei = ? WHERE address = ?', [String(amount(500)), user.agentAddress.toLowerCase()])
  const snapshot = await jars.snapshot(user)
  assert.equal(snapshot.totalGd, 500)
  assert.equal(snapshot.jars.reduce((sum, jar) => sum + jar.balanceGd, 0), 500)
})

test('both wallet balances and allowance are read at the same chain block', async () => {
  const user = await fixture()
  const originals = { balanceBlock: chain.balanceBlock, gdBalance: chain.gdBalance, gdAllowance: chain.gdAllowance }
  const blocks = []
  chain.balanceBlock = async () => 123n
  chain.gdBalance = async (_address, block) => { blocks.push(block); return amount(500) }
  chain.gdAllowance = async (_address, block) => { blocks.push(block); return amount(500) }
  process.env.CHAIN_MODE = 'celo'
  try {
    assert.equal((await spend.spendingPower(user)).totalWei, amount(1000))
    assert.deepEqual(blocks, [123n, 123n, 123n])
  } finally { process.env.CHAIN_MODE = 'mock'; Object.assign(chain, originals) }
})

after(async () => { (await db()).close(); rmSync(directory, { recursive: true, force: true }) })

test('a bill bigger than its jar uses unbudgeted G$, never another jar', async () => {
  const user = await fixture({ ai: 50, light: 200 }, 1000) // 750 G$ not budgeted to any jar
  await spend.spendGd(user, amount(300), { id: `${user.id}:big`, jar: 'ai' })
  assert.equal(await chain.gdBalance(user.agentAddress), amount(700))
  assert.equal(await balance(user, 'ai'), 0n)
  assert.equal(await balance(user, 'light'), amount(200))
})

test('network fees Jara fronted are repaid once, inside the next payment', async () => {
  const user = await fixture({ ai: 500 }, 1000)
  await run('UPDATE users SET gas_owed_wei = ? WHERE id = ?', [String(amount(10)), user.id])
  const request = { id: `${user.id}:fee`, jar: 'ai' }
  await spend.spendGd(user, amount(100), request)
  await spend.spendGd(user, amount(100), request) // retry: no second charge
  assert.equal(await chain.gdBalance(user.agentAddress), amount(890))
  assert.equal(await spend.getGasOwed(user.id), 0n)
  assert.equal(await balance(user, 'ai'), amount(400))
})

test('a shared signer lock queues the second caller instead of failing it', async () => {
  const { withMoneyLock } = require('../src/lib/money-lock.ts')
  const order = []
  let release
  const hold = new Promise((resolve) => { release = resolve })
  let started
  const ready = new Promise((resolve) => { started = resolve })
  const first = withMoneyLock('signer:test', async () => { started(); await hold; order.push('first') }, { waitMs: 5000 })
  await ready
  const second = withMoneyLock('signer:test', async () => { order.push('second') }, { waitMs: 5000 })
  setTimeout(release, 300)
  await Promise.all([first, second])
  assert.deepEqual(order, ['first', 'second'])
})
