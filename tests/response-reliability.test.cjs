/* eslint-disable @typescript-eslint/no-require-imports */
const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { createHash } = require('node:crypto')
const { parseEther } = require('viem')
const directory = mkdtempSync(`${tmpdir()}/jara-responses-`)
Object.assign(process.env, { DATABASE_URL: `file:${directory}/test.db`, CHAIN_MODE: 'mock', TOPUP_PROVIDER: 'mock', DEMO_BILLS: 'true', GD_NGN_RATE: '1', PRICE_SPREAD_BPS: '0', TREASURY_PRIVATE_KEY: `0x${'1'.repeat(64)}` })
const { db, run } = require('../src/lib/db.ts')
const users = require('../src/lib/users.ts')
const chain = require('../src/lib/chain.ts')
chain.balanceBlock = async () => undefined
const llm = require('../src/lib/agent/llm.ts')
const jars = require('../src/lib/jars.ts')
const agent = require('../src/lib/agent/index.ts')
const session = require('../src/lib/session.ts')
const shared = require('../src/app/api/_shared.ts')
const { withMoneyLock } = require('../src/lib/money-lock.ts')
const { directIntent } = require('../src/lib/agent/fallback.ts')
const { ApiError, readApiResponse } = require('../src/lib/api-response.ts')
const billRoute = require('../src/app/api/bills/route.ts')
const chatRoute = require('../src/app/api/chat/route.ts')
const walletRoute = require('../src/app/api/wallet/route.ts')
// These route unit tests have no Next request lifecycle. Auto-pay integration
// tests exercise the queued work separately; it must not block these replies.
require('../src/lib/auto-pay-after.ts').scheduleAutoPay = () => {}
const { FalconPayProvider } = require('../src/lib/providers/falconpay.ts')
const post = (path, body) => new Request(`http://localhost${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

async function fixture() {
  let user = await users.createUser()
  await users.updateUser(user.id, { connected: true, rootAddress: `0x${createHash('sha256').update(user.id).digest('hex').slice(0, 40)}` })
  user = await users.getUserById(user.id)
  await chain.mockDeposit(user.agentAddress, parseEther('1000'))
  await run('UPDATE jars SET target_ngn = 0 WHERE user_id = ?', [user.id])
  await run("UPDATE jars SET balance_wei = ? WHERE user_id = ? AND kind = 'airtime'", [String(parseEther('1000')), user.id])
  return user
}

test('HTML, empty and truncated responses produce a safe retry message, never a JSON exception', async () => {
  for (const [body, status] of [['<html>Gateway timeout</html>', 504], ['', 500], ['{"reply":', 200], ['null', 200]]) {
    await assert.rejects(readApiResponse(new Response(body, { status })), (error) => error instanceof ApiError && error.retryable && error.code === 'invalid_response' && !/Unexpected|SyntaxError|<html>/.test(error.message))
  }
  await assert.rejects(readApiResponse(Response.json({ error: 'Choose a phone number.' }, { status: 400 })), (error) => error.message === 'Choose a phone number.' && !error.retryable)
  assert.deepEqual(await readApiResponse(Response.json({ reply: { text: 'Done' } })), { reply: { text: 'Done' } })
})

test('concurrent bill and chat requests return retryable JSON while preserving the original request', async () => {
  const user = await fixture()
  const original = session.requireUser
  session.requireUser = async () => user
  let release, entered
  const ready = new Promise((r) => { entered = r })
  const held = new Promise((r) => { release = r })
  const worker = withMoneyLock(`user:${user.id}`, async () => { entered(); await held })
  await ready
  try {
    const bill = await billRoute.POST(post('/api/bills', { action: 'prepare', kind: 'airtime', amountNgn: 100, network: 'mtn', phone: '08031234567' }))
    const chat = await chatRoute.POST(post('/api/chat', { text: 'Hi', requestId: 'busy-chat-request', response: 'compact' }))
    for (const response of [bill, chat]) {
      assert.equal(response.status, 409)
      const body = await response.json()
      assert.equal(body.code, 'operation_busy')
      assert.equal(body.retryable, true)
      assert.match(body.error, /same request/)
    }
  } finally { release(); await worker; session.requireUser = original }
  assert.equal(await chain.gdBalance(user.agentAddress), parseEther('1000'))
})

test('a completed airtime response does not wait for a dashboard RPC refresh, and retry does not charge twice', async () => {
  const user = await fixture()
  const originals = { requireUser: session.requireUser, userState: shared.userState }
  session.requireUser = async () => (await users.getUserById(user.id))
  shared.userState = async () => { throw new Error('Balance RPC unavailable') }
  try {
    const prepared = await billRoute.POST(post('/api/bills', { action: 'prepare', kind: 'airtime', amountNgn: 100, network: 'mtn', phone: '08031234567' }))
    assert.equal(prepared.status, 200)
    const { id } = await prepared.json()
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await billRoute.POST(post('/api/bills', { action: 'confirm', actionId: id, response: 'compact' }))
      assert.equal(response.status, 200)
      assert.match((await response.json()).reply.text, /Done/)
    }
    assert.equal(await chain.gdBalance(user.agentAddress), parseEther('900'))
    assert.equal((await run('SELECT COUNT(*) AS n FROM payments WHERE user_id = ?', [user.id])).rows[0].n, 1)
  } finally { session.requireUser = originals.requireUser; shared.userState = originals.userState }
})

test('chat can show a greeting without waiting for either AI or balance services', async () => {
  const user = await fixture()
  const originals = { requireUser: session.requireUser, userState: shared.userState, snapshot: jars.snapshot, reachable: llm.llmReachable }
  session.requireUser = async () => user
  shared.userState = jars.snapshot = llm.llmReachable = async () => { throw new Error('Must not wait for this service') }
  try {
    const response = await chatRoute.POST(post('/api/chat', { text: 'Hello Jara!', requestId: 'instant-greeting', response: 'compact' }))
    assert.equal(response.status, 200)
    const result = await response.json()
    assert.match(result.reply.text, /How can I help/)
    assert.equal(result.messages.length, 2)
  } finally { session.requireUser = originals.requireUser; shared.userState = originals.userState; jars.snapshot = originals.snapshot; llm.llmReachable = originals.reachable }
})

test('retrying a withdrawal returns one transfer and one activity receipt', async () => {
  const user = await fixture()
  const originals = { requireUser: session.requireUser, userState: shared.userState }
  session.requireUser = async () => user
  shared.userState = async () => ({ activity: await users.listActivity(user.id) })
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const response = await walletRoute.POST(post('/api/wallet', { action: 'withdraw', requestId: 'receipt-replay' }))
      assert.equal(response.status, 200)
      const { activity } = await response.json()
      assert.equal(activity.filter((a) => a.type === 'move').length, 1)
    }
    assert.equal(await chain.gdBalance(user.agentAddress), 0n)
    assert.equal(await chain.gdBalance(user.rootAddress), parseEther('1000'))
  } finally { session.requireUser = originals.requireUser; shared.userState = originals.userState }
})

test('invalid JSON bodies and unexpected upstream failures still return structured API errors', async () => {
  const user = await fixture()
  const originalSession = session.requireUser
  const originalResolve = agent.resolvePending
  session.requireUser = async () => user
  agent.resolvePending = async () => { throw new Error('Internal RPC response with private details') }
  try {
    for (const route of [billRoute, chatRoute]) assert.equal((await route.POST(post('/api/bills', null))).status, 400)
    const response = await billRoute.POST(post('/api/bills', { action: 'confirm', actionId: 'saved-bill', response: 'compact' }))
    assert.equal(response.status, 503)
    const body = await response.json()
    assert.equal(body.retryable, true)
    assert.doesNotMatch(body.error, /private details/)
  } finally { session.requireUser = originalSession; agent.resolvePending = originalResolve }
})

test('the fast airtime path requires an explicit complete request and still requires confirmation', async () => {
  for (const text of ["Don't buy ₦200 airtime", 'If my balance is enough buy ₦200 airtime', 'What is airtime?', 'Buy ₦200 airtime and send ₦500 to someone', '₦200 airtime tomorrow']) assert.equal(directIntent(text), null)
  assert.equal(directIntent('What’s in my jars?').type, 'balance')
  const user = await fixture()
  const original = llm.llmReachable
  llm.llmReachable = async () => { throw new Error('Fast airtime must not wait for the model') }
  try {
    const result = await agent.handleMessage(user.id, 'Buy ₦200 MTN airtime to 0803 123 4567', 'fast-airtime')
    assert.ok(result.confirm?.id)
    assert.equal(result.confirm.gd, 200)
    assert.equal(await chain.gdBalance(user.agentAddress), parseEther('1000'))
    assert.equal((await users.getUserById(user.id)).pending.phone, '08031234567')
  } finally { llm.llmReachable = original }
})

test('a model-proposed bill returns its confirmation without a second inference call', async () => {
  const user = await fixture()
  const originals = { chat: llm.chat, reachable: llm.llmReachable }
  let calls = 0
  llm.llmReachable = async () => true
  llm.chat = async (_messages, _tools, _tokens, opts) => {
    calls++
    assert.equal(opts.think, false)
    assert.ok(opts.timeoutMs <= 12000)
    return { role: 'assistant', content: null, tool_calls: [{ id: 'prepare-1', type: 'function', function: { name: 'propose_bill', arguments: JSON.stringify({ kind: 'airtime', amount_ngn: 100, phone: '08031234567' }) } }] }
  }
  try {
    const reply = await agent.handleMessage(user.id, 'Abeg help me recharge my line', 'model-proposal')
    assert.ok(reply.confirm)
    assert.equal(calls, 1)
  } finally { llm.chat = originals.chat; llm.llmReachable = originals.reachable }
})

test('if AI times out after a tool changed a jar, return that result without running a fallback action', async () => {
  const user = await fixture()
  const originals = { chat: llm.chat, reachable: llm.llmReachable }
  let calls = 0
  llm.llmReachable = async () => true
  llm.chat = async () => {
    if (++calls > 1) throw new Error('Model timeout')
    return { role: 'assistant', content: null, tool_calls: [{ id: 'set-1', type: 'function', function: { name: 'set_jar', arguments: '{"jar":"airtime","target_ngn":500}' } }] }
  }
  try {
    const reply = await agent.handleMessage(user.id, 'Set my airtime savings target to 500 naira', 'post-tool-timeout')
    assert.equal(reply.text, 'updated airtime jar')
    assert.equal((await jars.getJars(user.id)).find((j) => j.kind === 'airtime').targetNgn, 500)
    assert.equal((await users.getUserById(user.id)).pending, null)
    assert.equal(calls, 2)
  } finally { llm.chat = originals.chat; llm.llmReachable = originals.reachable }
})

test('a timed-out provider purchase stays pending and is resolved by its original reference', async () => {
  const originalFetch = global.fetch
  const originalKey = process.env.FALCONPAY_API_KEY
  process.env.FALCONPAY_API_KEY = 'local-test-only'
  let payments = 0
  global.fetch = async (url, init) => {
    const target = new URL(url)
    if (target.pathname.endsWith('/services')) return Response.json({ data: [{ service_id: 'mtn', name: 'MTN' }] })
    if (target.pathname.endsWith('/quote')) return Response.json({ data: { face_amount: 100, amount_to_be_debited: 100, quote_token: 'fixture', quote_exp: 123 } })
    if (target.pathname.endsWith('/pay')) { payments++; assert.equal(JSON.parse(init.body).reference, 'same-payment'); throw new DOMException('Timed out', 'TimeoutError') }
    assert.equal(target.searchParams.get('reference'), 'same-payment')
    return Response.json({ data: { status: 'completed', settled: true } })
  }
  try {
    const provider = new FalconPayProvider()
    const purchase = await provider.buyAirtime({ reference: 'same-payment', network: 'mtn', amount: 100, phone: '08031234567' })
    assert.equal(purchase.state, 'pending')
    assert.equal((await provider.getStatus(purchase.reference)).state, 'success')
    assert.equal(payments, 1)
  } finally { global.fetch = originalFetch; if (originalKey === undefined) delete process.env.FALCONPAY_API_KEY; else process.env.FALCONPAY_API_KEY = originalKey }
})

test('streamed AI answers disable hidden reasoning so answer tokens can arrive immediately', async () => {
  const originalFetch = global.fetch
  const previousModel = process.env.LLM_MODEL
  process.env.LLM_MODEL = 'deepseek-v4-flash'
  global.fetch = async (_url, init) => {
    assert.deepEqual(JSON.parse(init.body).thinking, { type: 'disabled' })
    return new Response('data: {"choices":[{"delta":{"content":"Hello"}}]}\n\ndata: [DONE]\n\n')
  }
  try {
    const parts = []
    for await (const part of llm.chatStream([{ role: 'user', content: 'Hello' }])) parts.push(part)
    assert.deepEqual(parts, ['Hello'])
  } finally { global.fetch = originalFetch; if (previousModel === undefined) delete process.env.LLM_MODEL; else process.env.LLM_MODEL = previousModel }
})

after(async () => { (await db()).close(); rmSync(directory, { recursive: true, force: true }) })
