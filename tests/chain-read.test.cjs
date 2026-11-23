/* eslint-disable @typescript-eslint/no-require-imports */
const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const { encodeAbiParameters } = require('viem')
Object.assign(process.env, { CHAIN_MODE: 'celo', CELO_RPC_URL: 'https://rpc.test.invalid', TREASURY_PRIVATE_KEY: `0x${'1'.repeat(64)}` })
const { gdBalance, gdAllowance } = require('../src/lib/chain.ts')
const { retryBlockRead } = require('../src/lib/chain-read.ts')
const originalFetch = global.fetch
let requests = [], failures = 0
global.fetch = async (_url, init) => {
  const req = JSON.parse(init.body)
  requests.push(req)
  return Response.json({ jsonrpc: '2.0', id: req.id, ...(failures-- > 0
    ? { error: { code: -32000, message: 'block is out of range' } }
    : { result: encodeAbiParameters([{ type: 'uint256' }], [100n]) }) })
}

test('a lagging RPC retries token balances and allowances at the original block', async () => {
  const owner = `0x${'2'.repeat(40)}`
  for (const read of [() => gdBalance(owner, 123n), () => gdAllowance(owner, 123n)]) {
    requests = []; failures = 2
    assert.equal(await read(), 100n)
    assert.equal(requests.length, 3)
    for (const req of requests) {
      assert.equal(req.method, 'eth_call')
      assert.equal(req.params[1], '0x7b', 'do not substitute latest or a stale block')
      assert.deepEqual(req.params, requests[0].params)
    }
  }
})

test('unrelated errors fail immediately and persistent block lag has bounded retries', async () => {
  let attempts = 0
  const unrelated = new Error('execution reverted')
  await assert.rejects(retryBlockRead(async () => { attempts++; throw unrelated }), (error) => error === unrelated)
  assert.equal(attempts, 1)
  attempts = 0
  await assert.rejects(retryBlockRead(async () => { attempts++; throw new Error('block is out of range') }), /out of range/)
  assert.equal(attempts, 5)
})

after(() => { global.fetch = originalFetch })
