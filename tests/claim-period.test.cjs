/* eslint-disable @typescript-eslint/no-require-imports */
const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const { encodeAbiParameters, toHex } = require('viem')

Object.assign(process.env, { CHAIN_MODE: 'celo', CELO_RPC_URL: 'https://rpc.test.invalid' })
const { ubiClaimPeriod, GD } = require('../src/lib/chain.ts')
const originalFetch = global.fetch
const start = 1677672000n // GoodDollar production period origin: noon UTC
let timestamp = start, requests = []
global.fetch = async (_url, init) => {
  const req = JSON.parse(init.body)
  requests.push(req)
  let result
  if (req.method === 'eth_getBlockByNumber') {
    result = { number: '0x42', timestamp: toHex(timestamp), transactions: [] }
  } else if (req.method === 'eth_call') {
    assert.equal(req.params[0].to.toLowerCase(), GD.ubi.toLowerCase())
    assert.equal(req.params[1], '0x42', 'period origin must be read at the timestamp block')
    result = encodeAbiParameters([{ type: 'uint256' }], [start])
  } else throw new Error(`Unexpected RPC ${req.method}`)
  return Response.json({ jsonrpc: '2.0', id: req.id, result })
}

test('claim period follows chain time across noon UTC even when the server clock differs', async () => {
  const now = Date.now
  Date.now = () => 0
  try {
    timestamp = start + 86400n - 1n
    const before = await ubiClaimPeriod()
    assert.equal(before.startsAt, Number(start) * 1000)
    assert.equal(before.endsAt, Number(start + 86400n) * 1000)
    timestamp += 1n
    const after = await ubiClaimPeriod()
    assert.notEqual(after.id, before.id)
    assert.equal(after.startsAt, before.endsAt)
    timestamp += 11n * 3600n // next Lagos calendar day, still the same UBI cycle
    assert.equal((await ubiClaimPeriod()).id, after.id)
    assert.equal(requests.length, 6)
  } finally { Date.now = now }
})

test('a future contract origin fails closed instead of allocating a false claim period', async () => {
  timestamp = start - 1n
  await assert.rejects(ubiClaimPeriod(), /not started/)
})

after(() => { global.fetch = originalFetch })
