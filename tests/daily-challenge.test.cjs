/* eslint-disable @typescript-eslint/no-require-imports */
const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { privateKeyToAccount } = require('viem/accounts')
const { recoverMessageAddress } = require('viem')
const directory = mkdtempSync(`${tmpdir()}/jara-challenge-`)
const signerKey = `0x${'12'.repeat(32)}`
const signer = privateKeyToAccount(signerKey)
const contract = `0x${'ab'.repeat(20)}`
Object.assign(process.env, { DATABASE_URL: `file:${directory}/test.db`, CHAIN_MODE: 'celo', TOPUP_PROVIDER: 'mock', DAILY_CHALLENGE_CONTRACT: contract, DAILY_CHALLENGE_ENABLED: 'true', DAILY_CHALLENGE_SIGNER_KEY: signerKey })
const { run, db } = require('../src/lib/db.ts')
const shared = require('../src/lib/daily-challenge-shared.ts')
const { dailyQuestions } = require('../src/lib/daily-challenge-questions.ts')
const chain = require('../src/lib/chain.ts')
const transport = require('../src/lib/daily-challenge-chain.ts')
const today = shared.challengeDay()
const root = `0x${'01'.repeat(20)}`
const user = { id: 'challenge-user', rootAddress: root, connected: true }
const users = Array.from({ length: 9 }, (_, i) => `0x${(i + 1).toString(16).padStart(40, '0')}`)
let paused = false, verified = root, finalizedAt = BigInt(Math.floor(shared.dayClosesAt(today - 1) / 1000)), failRead = false
const entries = new Map()
chain.whitelistedRoot = async () => verified
transport.challengeClient = () => ({
  getBlock: async () => ({ number: 100n, hash: `0x${'ff'.repeat(32)}`, timestamp: finalizedAt }),
  readContract: async ({ functionName, args = [], blockNumber }) => {
    if (failRead) throw new Error('RPC unavailable')
    if (functionName === 'startDay') return BigInt(today - 10)
    if (functionName === 'endDay') return BigInt(today + 3)
    if (functionName === 'paused') return paused
    if (functionName === 'completionSigner') return signer.address
    if (functionName === 'identity') return chain.GD.identity
    if (functionName === 'entryCount') return BigInt((entries.get(Number(args[0])) || []).length)
    if (functionName === 'participantAt') { assert.equal(blockNumber, 100n); return entries.get(Number(args[0]))[Number(args[1])] }
    if (functionName === 'entered') return (entries.get(Number(args[0])) || []).includes(args[1])
    if (functionName === 'progress') return [BigInt(today - 1), 3n]
    throw new Error(`Unexpected read ${functionName}`)
  },
})
const service = require('../src/lib/daily-challenge.ts')

test('Lagos midnight has the same day boundary as the contract', () => {
  assert.equal(shared.challengeDay(Date.parse('2026-11-18T22:59:59Z')), shared.challengeDay(Date.parse('2026-11-18T00:00:00Z')))
  assert.equal(shared.challengeDay(Date.parse('2026-11-18T23:00:00Z')), shared.challengeDay(Date.parse('2026-11-18T00:00:00Z')) + 1)
  assert.equal(new Date(shared.dayClosesAt(shared.challengeDay(Date.parse('2026-11-18T12:00:00Z')))).toISOString(), '2026-11-18T23:00:00.000Z')
})

test('quiz validation, immutable retries, review, and root-bound completion signatures', async () => {
  await assert.rejects(service.prepareChallengeEntry(user, today), /Complete today/)
  for (const invalid of [[0], [0, 1, 99], [0, 1, '2'], [0, null, 1]]) await assert.rejects(service.submitChallenge(user, today, invalid), /Answer all/)
  await assert.rejects(service.submitChallenge(user, today - 1, [0, 0, 0]), /new day/)
  await assert.rejects(service.submitChallenge({ ...user, connected: false }, today, [0, 0, 0]), /Connect/)
  const result = await service.submitChallenge(user, today, [0, 0, 0])
  assert.equal(result.review.length, 3)
  assert.deepEqual(await service.submitChallenge(user, today, [1, 1, 1]), result)
  const ticket = await service.prepareChallengeEntry(user, today)
  assert.equal(ticket.contract, contract)
  assert.equal(ticket.challengeId, shared.challengeId(today))
  const recovered = await recoverMessageAddress({ message: { raw: shared.completionHash(contract, root, today) }, signature: ticket.signature })
  assert.equal(recovered, signer.address)
  verified = null
  await assert.rejects(service.prepareChallengeEntry(user, today), /verification/)
  verified = root
  paused = true
  await assert.rejects(service.prepareChallengeEntry(user, today), /not open/)
  paused = false
  const view = await service.challengeView(user)
  assert.equal(view.entered, false, 'quiz completion alone is not an entry')
  assert.equal(view.streak, 3)
  assert.equal('correctOption' in view.questions[0], false)
  assert.equal(view.review.length, 3)
  entries.set(today, [root])
  assert.equal((await service.challengeView(user)).entered, true, 'on-chain entry recovers without a browser callback')
})

test('bank provides three complete questions for each day of the weekly rotation', () => {
  for (let d = today; d < today + 7; d++) {
    const set = dailyQuestions(d)
    assert.equal(set.questions.length, 3)
    for (const q of set.questions) { assert.equal(new Set(q.options).size, 3); assert.ok(q.options[q.correctOption]); assert.ok(q.explanation.length > 20) }
  }
})

test('draws wait for close and finality, include on-chain-only users, and cannot reroll', async () => {
  await assert.rejects(service.drawChallenge(today), /closed day/)
  const day = today - 1
  entries.set(day, users)
  finalizedAt -= 1n
  await assert.rejects(service.drawChallenge(day), /finalize/)
  finalizedAt += 1n
  const results = await Promise.all([service.drawChallenge(day), service.drawChallenge(day)])
  assert.equal(results.filter((r) => !r.existing).length, 1)
  const draw = (await run('SELECT * FROM daily_challenge_draws WHERE day = ?', [day])).rows[0]
  assert.deepEqual(JSON.parse(draw.participants), users)
  const winners = (await run('SELECT root FROM daily_challenge_winners WHERE day = ? ORDER BY rank', [day])).rows.map((w) => w.root)
  assert.equal(winners.length, 5)
  assert.equal(new Set(winners).size, 5)
  assert.deepEqual(winners, service.selectWinners(users, draw.seed))
  await service.drawChallenge(day)
  assert.equal((await run('SELECT seed FROM daily_challenge_draws WHERE day = ?', [day])).rows[0].seed, draw.seed)
  entries.set(today - 2, users.slice(0, 2))
  await service.drawChallenge(today - 2)
  assert.equal((await run('SELECT COUNT(*) AS n FROM daily_challenge_winners WHERE day = ?', [today - 2])).rows[0].n, 2)
  await service.drawChallenge(today - 3)
  assert.equal((await run('SELECT COUNT(*) AS n FROM daily_challenge_winners WHERE day = ?', [today - 3])).rows[0].n, 0)
  failRead = true
  await assert.rejects(service.drawChallenge(today - 4), /RPC/)
  failRead = false
  assert.equal((await run('SELECT COUNT(*) AS n FROM daily_challenge_draws WHERE day = ?', [today - 4])).rows[0].n, 0)
})

test('only winners can save a recipient; recipient and successful delivery receipt are immutable', async () => {
  const day = today - 1
  const winner = (await run('SELECT root FROM daily_challenge_winners WHERE day = ? LIMIT 1', [day])).rows[0].root
  const winnerUser = { ...user, rootAddress: winner }
  await assert.rejects(service.savePrizePhone(user, day, '08012345678', 'mtn'), /No unclaimed/)
  await assert.rejects(service.savePrizePhone(winnerUser, day, '123', 'mtn'), /11-digit/)
  await assert.rejects(service.recordPrizeDelivery(day, winner, 'provider-001'), /missing/)
  await service.savePrizePhone(winnerUser, day, '08012345678', 'mtn')
  await service.savePrizePhone(winnerUser, day, '08012345678', 'mtn')
  await assert.rejects(service.savePrizePhone(winnerUser, day, '08087654321', 'mtn'), /already saved/)
  await service.recordPrizeDelivery(day, winner, 'provider-001')
  await service.recordPrizeDelivery(day, winner, 'provider-001')
  await assert.rejects(service.recordPrizeDelivery(day, winner, 'provider-002'), /another receipt/)
  const row = (await run('SELECT * FROM daily_challenge_winners WHERE day = ? AND root = ?', [day, winner])).rows[0]
  assert.equal(row.delivery_ref, 'provider-001')
  assert.ok(row.recipient_at && row.delivered_at)
  const outsider = await service.challengeView(user)
  assert.equal(outsider.prizes.length, 0)
  assert.equal(JSON.stringify(outsider.results).includes('08012345678'), false)
})

test('disabled campaigns preserve past prizes, and mock mode cannot sign or read real campaigns', async () => {
  process.env.DAILY_CHALLENGE_ENABLED = 'false'
  assert.equal((await service.challengeView(user)).available, false)
  await assert.rejects(service.prepareChallengeEntry(user, today), /not open/)
  process.env.CHAIN_MODE = 'mock'
  assert.equal(service.challengeConfig().address, null)
  await assert.rejects(service.prepareChallengeEntry(user, today), /not open/)
  const { assertSafeRuntime } = require('../src/lib/env.ts')
  assert.throws(assertSafeRuntime, /credentials/)
  process.env.CHAIN_MODE = 'celo'
})

test('API gates admin operations and authentication; public audit records never include recipients', async () => {
  const { NextResponse } = require('next/server')
  const session = require('../src/lib/session.ts')
  session.requireUser = async () => NextResponse.json({ error: 'Not signed in' }, { status: 401 })
  const api = require('../src/app/api/challenges/route.ts')
  assert.equal((await api.GET()).status, 401)
  assert.equal((await api.POST(new Request('http://localhost/api/challenges', { method: 'POST' }))).status, 401)
  session.requireUser = async () => user
  assert.equal((await api.POST(new Request('http://localhost/api/challenges', { method: 'POST', body: '{}' }))).status, 400)
  assert.equal((await api.POST(new Request('http://localhost/api/challenges', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'prepare', day: today, reviewed: false }) }))).status, 400)
  process.env.ADMIN_KEY = 'test-admin-only'
  const admin = require('../src/app/api/admin/challenges/route.ts')
  assert.equal((await admin.GET(new Request('http://localhost/api/admin/challenges'))).status, 401)
  assert.equal((await admin.POST(new Request('http://localhost/api/admin/challenges', { method: 'POST', headers: { Authorization: 'Bearer incorrect' } }))).status, 401)
  const report = await admin.GET(new Request('http://localhost/api/admin/challenges', { headers: { Authorization: 'Bearer test-admin-only' } }))
  assert.equal(report.status, 200)
  assert.ok((await report.json()).winners.length)
  const publicApi = require('../src/app/api/challenges/results/route.ts')
  const result = await publicApi.GET(new Request(`http://localhost/api/challenges/results?day=${today - 1}`))
  assert.equal(result.status, 200)
  const text = await result.text()
  assert.equal(text.includes('08012345678'), false)
  assert.equal(text.includes('provider-001'), false)
  assert.ok(text.includes('seed'))
})

after(async () => { (await db()).close(); rmSync(directory, { recursive: true, force: true }) })
