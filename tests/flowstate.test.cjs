/* eslint-disable @typescript-eslint/no-require-imports */
const test = require('node:test')
const assert = require('node:assert/strict')
const { encodeFunctionData } = require('viem')
const { generatePrivateKey, privateKeyToAccount } = require('viem/accounts')
const flow = require('@/lib/flowstate')
const route = require('@/app/api/flowstate/route')
const { NextRequest } = require('next/server')

const other = '0x1111111111111111111111111111111111111111'
const snap = (over = {}) => ({ votingPower: 10n, votes: [], maxSpread: 0, verified: true, recipientActive: true, ...over })

test('the ballot only ever names Jara, preserving other allocations', () => {
  const votes = flow.buildFlowVote(snap({ votes: [{ recipient: other, amount: 4n }] }), '6')
  assert.deepEqual(votes, [{ recipient: flow.PROJECT_RECIPIENT, amount: 6n }])
  assert.throws(() => flow.buildFlowVote(snap({ votes: [{ recipient: other, amount: 4n }] }), '7'), /between 1 and 6/)
  assert.throws(() => flow.buildFlowVote(snap({ verified: false }), '1'), /verification/)
  assert.throws(() => flow.buildFlowVote(snap({ votingPower: 0n }), '1'), /Claim your voting rights/)
  assert.throws(() => flow.buildFlowVote(snap({ maxSpread: 1, votes: [{ recipient: other, amount: 1n }] }), '1'), /project limit/)
  assert.throws(() => flow.buildFlowVote(snap(), '1.5'), /whole number/)
})

test('a confirmed transaction must be exactly the reviewed ballot', () => {
  const from = '0x2222222222222222222222222222222222222222'
  const input = encodeFunctionData({ abi: flow.FLOW_ABI, functionName: 'vote', args: [[{ recipient: flow.PROJECT_RECIPIENT, amount: 3n }]] })
  const tx = { from, to: flow.FLOW_COUNCIL, input, value: 0n }
  assert.equal(flow.matchesFlowVoteTransaction(from, '3', tx), true)
  assert.equal(flow.matchesFlowVoteTransaction(from, '4', tx), false)
  assert.equal(flow.matchesFlowVoteTransaction(other, '3', tx), false)
  assert.equal(flow.matchesFlowVoteTransaction(from, '3', { ...tx, to: other }), false)
  assert.equal(flow.matchesFlowVoteTransaction(from, '3', { ...tx, input: '0x' }), false)
})

const post = (body, headers = { 'x-flow-vote': '1', 'content-type': 'application/json' }) =>
  route.POST(new NextRequest('http://localhost/api/flowstate', { method: 'POST', headers, body: JSON.stringify(body) }))

test('the relay rejects cross-site, malformed and forged claims before calling Flowstate', async (t) => {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (...args) => { calls.push(args); return Response.json({ success: true }) })
  assert.equal((await post({}, { 'content-type': 'application/json' })).status, 403)
  assert.equal((await post({}, { 'x-flow-vote': '1', origin: 'https://evil.example' })).status, 403)
  assert.equal((await post({ address: other, issuedAt: Date.now(), signature: '0x00' })).status, 400)
  const account = privateKeyToAccount(generatePrivateKey())
  const issuedAt = Date.now()
  const forged = await account.signMessage({ message: flow.flowClaimMessage(other, issuedAt) })
  assert.equal((await post({ address: other, issuedAt, signature: forged })).status, 401)
  assert.equal(calls.length, 0)
})

test('a valid claim is forwarded to Flowstate for the pinned council only', async (t) => {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, init) => { calls.push({ url, body: JSON.parse(init.body) }); return Response.json({ success: true }) })
  const account = privateKeyToAccount(generatePrivateKey())
  const issuedAt = Date.now()
  const signature = await account.signMessage({ message: flow.flowClaimMessage(account.address, issuedAt) })
  const res = await post({ address: account.address, issuedAt, signature })
  assert.equal(res.status, 200)
  assert.equal(calls.length, 1)
  assert.match(String(calls[0].url), /flowstate\.network\/api\/flow-council\/eligibility$/)
  assert.equal(calls[0].body.councilId, flow.FLOW_COUNCIL)
  assert.equal(calls[0].body.chainId, 42220)
})

test('council details are refused if Jara’s pinned listing changes name', async (t) => {
  const groups = { groups: [{ eligibilityMethod: 'gooddollar', defaultVotingPower: 10 }] }
  let name = 'Jara'
  t.mock.method(globalThis, 'fetch', async (url) =>
    Response.json(String(url).includes('recipients') ? { recipients: [{ address: flow.PROJECT_RECIPIENT, name }] } : groups))
  const ok = await route.GET()
  assert.equal(ok.status, 200)
  assert.equal((await ok.json()).communityVotes, 10)
  name = 'Someone Else'
  assert.equal((await route.GET()).status, 503)
})
