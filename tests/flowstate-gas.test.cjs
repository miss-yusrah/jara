/* eslint-disable @typescript-eslint/no-require-imports */
const { test, after, beforeEach } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { decodeFunctionData, encodeFunctionResult, parseAbi, parseEther, zeroAddress } = require('viem')
const directory = mkdtempSync(`${tmpdir()}/jara-flow-gas-`)
Object.assign(process.env, { DATABASE_URL: `file:${directory}/test.db`, CHAIN_MODE: 'celo', TOPUP_PROVIDER: 'mock', GD_NGN_RATE: '1', TREASURY_PRIVATE_KEY: `0x${'1'.repeat(64)}`, CELO_RPC_URL: 'https://rpc.test.invalid' })
const { db, run } = require('../src/lib/db.ts')
const chain = require('../src/lib/chain.ts')
const outbox = require('../src/lib/chain-outbox.ts')
const session = require('../src/lib/session.ts')
const flow = require('../src/lib/flowstate.ts')
const route = require('../src/app/api/flowstate/gas/route.ts')
const { NextRequest, NextResponse } = require('next/server')

const root = '0x5555555555555555555555555555555555555555'
const faucetAbi = parseAbi(['function canTop(address _user) view returns (bool)'])
const rpcAbi = [...flow.FLOW_ABI, ...flow.IDENTITY_ABI, ...faucetAbi]
const GAS_PRICE = 25_000_000_000n // 25 gwei
let balance = 0n, gasUnits = 150_000n, canTop = false, whitelisted = root, votingPower = 10n, sent = []

const originalFetch = global.fetch
global.fetch = async (_url, init) => {
  const req = JSON.parse(init.body)
  const hex = (n) => `0x${n.toString(16)}`
  let result
  if (req.method === 'eth_chainId') result = hex(42220n)
  else if (req.method === 'eth_estimateGas') result = hex(gasUnits)
  else if (req.method === 'eth_getBalance') result = hex(balance)
  else if (req.method === 'eth_gasPrice') result = hex(GAS_PRICE)
  else if (req.method === 'eth_maxPriorityFeePerGas') result = hex(1_000_000_000n)
  else if (req.method === 'eth_getBlockByNumber') result = { number: '0x10', hash: `0x${'b'.repeat(64)}`, parentHash: `0x${'c'.repeat(64)}`, timestamp: '0x1', baseFeePerGas: hex(GAS_PRICE), gasLimit: '0x1', gasUsed: '0x1', transactions: [], logsBloom: `0x${'0'.repeat(512)}`, miner: zeroAddress, extraData: '0x', difficulty: '0x0', totalDifficulty: '0x0', size: '0x1', nonce: '0x0000000000000000', sha3Uncles: `0x${'0'.repeat(64)}`, uncles: [], stateRoot: `0x${'0'.repeat(64)}`, receiptsRoot: `0x${'0'.repeat(64)}`, transactionsRoot: `0x${'0'.repeat(64)}`, mixHash: `0x${'0'.repeat(64)}` }
  else if (req.method === 'eth_call') {
    const { functionName } = decodeFunctionData({ abi: rpcAbi, data: req.params[0].data })
    const values = {
      canTop,
      getWhitelistedRoot: whitelisted,
      maxVotingSpread: 0,
      getVotes: [],
      getVoter: { account: root, votingPower, votes: [] },
      getRecipient: { account: flow.PROJECT_RECIPIENT, votes: 19n },
    }
    if (!(functionName in values)) throw new Error(`Unexpected call ${functionName}`)
    result = encodeFunctionResult({ abi: rpcAbi, functionName, result: values[functionName] })
  } else throw new Error(`Unexpected RPC ${req.method}`)
  return Response.json({ jsonrpc: '2.0', id: req.id, result })
}
outbox.durableTransaction = async (id, _key, input) => {
  // Mirror the outbox: one row per id, the same intent on every retry.
  const intent = JSON.stringify({ to: input.to.toLowerCase(), data: input.data ?? '0x', value: String(input.value ?? 0n) })
  const saved = (await run('SELECT intent FROM chain_transactions WHERE id = ?', [id])).rows[0]
  if (saved && saved.intent !== intent) throw new Error('Transaction intent does not match its saved request.')
  if (!saved) {
    await run("INSERT INTO chain_transactions(id, sender, intent, raw, hash, status, created_at) VALUES (?, 'treasury', ?, '0x', ?, 'confirmed', ?)", [id, intent, `0x${String(sent.length).padStart(64, '0')}`, Date.now()])
    sent.push({ id, ...input })
    if (input.value) balance += input.value
  }
  return { hash: `0x${'a'.repeat(64)}`, feeWei: 0n }
}
let user = null
session.requireUser = async () => user ?? NextResponse.json({ error: 'Not signed in' }, { status: 401 })

const vote = encodeVote(5n)
function encodeVote(amount) {
  const { encodeFunctionData } = require('viem')
  return encodeFunctionData({ abi: flow.FLOW_ABI, functionName: 'vote', args: [[{ recipient: flow.PROJECT_RECIPIENT, amount }]] })
}
const post = (body, headers = { 'x-flow-vote': '1', 'content-type': 'application/json' }) =>
  route.POST(new NextRequest('http://localhost/api/flowstate/gas', { method: 'POST', headers, body: JSON.stringify(body) }))

beforeEach(async () => {
  balance = 0n; gasUnits = 150_000n; canTop = false; whitelisted = root; votingPower = 10n; sent = []
  user = { id: `u-${Math.random().toString(36).slice(2)}`, connected: true, rootAddress: root }
  await run('DELETE FROM chain_transactions')
})
after(async () => { global.fetch = originalFetch; (await db()).close(); rmSync(directory, { recursive: true, force: true }) })

test('a wallet that can already pay is not topped up', async () => {
  balance = parseEther('1')
  assert.equal(await chain.sponsorWalletCall(root, { to: flow.FLOW_COUNCIL, data: vote }, 'op-a'), false)
  assert.equal(sent.length, 0)
})

test('an empty wallet gets just enough CELO for the vote, once per operation', async () => {
  assert.equal(await chain.sponsorWalletCall(root, { to: flow.FLOW_COUNCIL, data: vote }, 'op-b'), true)
  assert.equal(sent.length, 1)
  assert.equal(sent[0].id, 'gas:op-b')
  assert.equal(sent[0].to, root)
  assert.ok(sent[0].value > 0n && sent[0].value <= chain.SPONSORED_CALL_CAP)
  // The same operation retried never pays twice.
  balance = 0n
  await chain.sponsorWalletCall(root, { to: flow.FLOW_COUNCIL, data: vote }, 'op-b')
  assert.equal(sent.length, 1)
})

test('GoodDollar’s free faucet is used before the treasury', async () => {
  canTop = true
  const realDurable = outbox.durableTransaction
  outbox.durableTransaction = async (id, key, input) => {
    const out = await realDurable(id, key, input)
    if (input.to === chain.GD.faucet) balance += parseEther('0.1') // the faucet pays
    return out
  }
  try {
    assert.equal(await chain.sponsorWalletCall(root, { to: flow.FLOW_COUNCIL, data: vote }, 'op-c'), true)
  } finally { outbox.durableTransaction = realDurable }
  assert.deepEqual(sent.map((s) => s.to), [chain.GD.faucet])
})

test('an abnormal fee is refused instead of draining the treasury', async () => {
  gasUnits = 1_000_000_000n
  await assert.rejects(chain.sponsorWalletCall(root, { to: flow.FLOW_COUNCIL, data: vote }, 'op-d'), /unusually high/)
  assert.equal(sent.length, 0)
})

test('the endpoint refuses cross-site, signed-out and ineligible requests', async () => {
  assert.equal((await post({ amount: '5' }, { 'content-type': 'application/json' })).status, 403)
  user = null
  assert.equal((await post({ amount: '5' })).status, 401)
  user = { id: 'u-x', connected: true, rootAddress: root }
  votingPower = 0n
  assert.match((await (await post({ amount: '5' })).json()).error, /Claim your voting rights/)
  votingPower = 10n
  whitelisted = zeroAddress
  assert.match((await (await post({ amount: '5' })).json()).error, /verification/)
  whitelisted = root
  assert.equal((await post({ amount: '11' })).status, 400)
  assert.equal(sent.length, 0)
})

test('the endpoint tops up only the account’s own wallet, at most three times', async () => {
  for (let i = 1; i <= 3; i++) {
    balance = 0n
    const res = await post({ amount: String(i) })
    assert.equal(res.status, 200)
    assert.equal((await res.json()).sponsored, true)
  }
  assert.equal(sent.length, 3)
  assert.ok(sent.every((s) => s.to === root))
  balance = 0n
  const capped = await post({ amount: '4' })
  assert.equal(capped.status, 409)
  assert.equal((await capped.json()).code, 'sponsor_limit')
  // Over the cap a wallet that can pay still proceeds, with nothing sent.
  balance = parseEther('1')
  assert.equal((await (await post({ amount: '4' })).json()).sponsored, false)
  assert.equal(sent.length, 3)
})
