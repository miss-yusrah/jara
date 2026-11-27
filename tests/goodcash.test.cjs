/* eslint-disable @typescript-eslint/no-require-imports */
const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { createHash, createHmac } = require('node:crypto')
const directory = mkdtempSync(`${tmpdir()}/jara-goodcash-`)
const SECRET = 'whsec_test_secret'
Object.assign(process.env, { DATABASE_URL: `file:${directory}/test.db`, CHAIN_MODE: 'mock', TOPUP_PROVIDER: 'mock', GD_NGN_RATE: '1', GOODCASH_WEBHOOK_SECRET: SECRET })
const { db, run } = require('../src/lib/db.ts')
const users = require('../src/lib/users.ts')
const dbModule = require('../src/lib/db.ts')
const { handleGoodCashWebhook } = require('../src/lib/goodcash.ts')
const { REWARD_RULES } = require('../src/lib/rewards.ts')

function signed(event, secret = SECRET, t = Math.floor(Date.now() / 1000)) {
  const raw = JSON.stringify(event)
  return [raw, `t=${t},v1=${createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex')}`]
}
async function person() {
  const user = await users.createUser()
  await users.updateUser(user.id, { connected: true, rootAddress: `0x${createHash('sha256').update(user.id).digest('hex').slice(0, 40)}` })
  return users.getUserById(user.id)
}
const paid = (user, id = 'evt_1', wallet = user.rootAddress) => ({ id, type: 'cashout.paid', data: { id: 'co_1', object: 'cashout', partnerRef: user.id, wallet, amountG: '5000', receive: { naira: 3200 } } })
const rows = async (user) => (await run("SELECT type, status, title, amount_ngn FROM activity WHERE user_id = ? AND provider = 'goodcash'", [user.id])).rows

test('only correctly signed, fresh webhooks are accepted', async () => {
  const user = await person()
  const [raw] = signed(paid(user))
  assert.equal((await handleGoodCashWebhook(raw, null)).status, 400)
  assert.equal((await handleGoodCashWebhook(raw, signed(paid(user), 'whsec_wrong')[1])).status, 400)
  assert.equal((await handleGoodCashWebhook(raw, signed(paid(user), SECRET, Math.floor(Date.now() / 1000) - 3600)[1])).status, 400)
  assert.equal((await rows(user)).length, 0)
})

test('a paid cash out is recorded once, as a cash out, and never unlocks the first-bill reward', async () => {
  const user = await person()
  const first = await handleGoodCashWebhook(...signed(paid(user)))
  assert.deepEqual(first, { status: 200, body: { ok: true } })
  const again = await handleGoodCashWebhook(...signed(paid(user)))
  assert.deepEqual(again.body, { ok: true, duplicate: true })
  const recorded = await rows(user)
  assert.equal(recorded.length, 1)
  assert.equal(recorded[0].type, 'cashout')
  assert.equal(Number(recorded[0].amount_ngn), 3200)
  const firstBill = REWARD_RULES.find((r) => r.key(user) === 'first-bill')
  assert.equal(await firstBill.eligible(user), false)
})

test('an event for another wallet records nothing, even with a real account id as partnerRef', async () => {
  const user = await person()
  const out = await handleGoodCashWebhook(...signed(paid(user, 'evt_spoof', '0x000000000000000000000000000000000000beef')))
  assert.deepEqual(out.body, { ok: true, ignored: 'unmatched' })
  assert.equal((await rows(user)).length, 0)
})

test('top-ups and failures are recorded with their own types; quiet events are acknowledged', async () => {
  const user = await person()
  await handleGoodCashWebhook(...signed({ id: 'evt_top', type: 'topup.delivered', data: { id: 'tu_1', partnerRef: user.id, wallet: user.rootAddress, amountNaira: 5000, asset: 'g' } }))
  await handleGoodCashWebhook(...signed({ id: 'evt_fail', type: 'cashout.failed', data: { id: 'co_2', partnerRef: user.id, wallet: user.rootAddress } }))
  const quiet = await handleGoodCashWebhook(...signed({ id: 'evt_delay', type: 'cashout.delayed', data: { id: 'co_3', partnerRef: user.id, wallet: user.rootAddress } }))
  assert.deepEqual(quiet.body, { ok: true, ignored: 'cashout.delayed' })
  assert.deepEqual((await rows(user)).map((r) => [r.type, r.status]).sort(), [['cashout', 'failed'], ['topup', 'done']])
})

test('if Jara cannot record an event it answers 5xx so GoodCash retries, and the retry is recorded once', async () => {
  const user = await person()
  const original = dbModule.atomic
  dbModule.atomic = async () => { throw new Error('database busy') }
  try {
    assert.equal((await handleGoodCashWebhook(...signed(paid(user, 'evt_retry')))).status, 500)
  } finally { dbModule.atomic = original }
  assert.equal((await handleGoodCashWebhook(...signed(paid(user, 'evt_retry')))).status, 200)
  assert.equal((await rows(user)).length, 1)
})

test('without a webhook secret nothing is accepted', async () => {
  delete process.env.GOODCASH_WEBHOOK_SECRET
  try {
    const user = await person()
    assert.equal((await handleGoodCashWebhook(...signed(paid(user)))).status, 503)
  } finally { process.env.GOODCASH_WEBHOOK_SECRET = SECRET }
})

after(async () => {
  ;(await db()).close()
  rmSync(directory, { recursive: true, force: true })
})
