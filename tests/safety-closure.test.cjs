/* eslint-disable @typescript-eslint/no-require-imports */
const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, rmSync } = require('node:fs')
const directory = mkdtempSync(require('node:path').join(require('node:os').tmpdir(), 'jara-safety-'))
Object.assign(process.env, { DATABASE_URL: `file:${directory}/test.db`, CHAIN_MODE: 'mock', TOPUP_PROVIDER: 'mock', TELEGRAM_WEBHOOK_SECRET: 'test-webhook-secret', WALLET_ENCRYPTION_KEY: '2'.repeat(64) })
for (const key of ['TREASURY_PRIVATE_KEY', 'FALCONPAY_API_KEY', 'VTPASS_API_KEY']) delete process.env[key]
const { db, run } = require('../src/lib/db.ts')
const users = require('../src/lib/users.ts')
const env = require('../src/lib/env.ts')
const { localKek } = require('../src/lib/custody.ts')
const { reserveReferralBudget } = require('../src/lib/rewards.ts')
const agent = require('../src/lib/agent/index.ts')
const telegram = require('../src/lib/telegram.ts')
require('../src/lib/auto-pay-after.ts').scheduleAutoPay = () => {}
const route = require('../src/app/api/telegram/route.ts')
async function restart() { (await db()).close(); delete global.__jaraDb }
async function webhook(body, secret = process.env.TELEGRAM_WEBHOOK_SECRET) {
  return route.POST(new Request('http://localhost/api/telegram', { method: 'POST', headers: { 'content-type': 'application/json', 'x-telegram-bot-api-secret-token': secret }, body: JSON.stringify(body) }))
}

test('Telegram refuses group linking, group commands, foreign callback senders and missing chat types', async () => {
  const user = await users.createUser()
  const originals = { handleMessage: agent.handleMessage, resolvePending: agent.resolvePending, sendMessage: telegram.sendMessage, sendTyping: telegram.sendTyping, answerCallback: telegram.answerCallback, editKeyboard: telegram.editKeyboard }
  const calls = []
  agent.handleMessage = async () => { calls.push('message'); return { text: 'ok' } }
  agent.resolvePending = async () => { calls.push('confirm'); return { text: 'ok' } }
  for (const key of ['sendMessage', 'sendTyping', 'answerCallback', 'editKeyboard']) telegram[key] = async () => {}
  try {
    for (const type of ['group', 'supergroup', 'channel', undefined]) {
      await webhook({ message: { message_id: 1, chat: { id: -99, type }, from: { id: 42 }, text: `/start ${user.linkCode}` } })
      await webhook({ callback_query: { id: 'callback', from: { id: 42 }, data: 'confirm:abcdef', message: { chat: { id: -99, type }, message_id: 1 } } })
    }
    assert.equal((await users.getUserById(user.id)).tgChatId, null)
    assert.equal((await users.getUserById(user.id)).linkCode, user.linkCode)
    await users.linkTelegram(user.id, '42')
    for (const from of [{ id: 43 }, { id: 42, is_bot: true }, undefined]) {
      await webhook({ message: { message_id: 2, chat: { id: 42, type: 'private' }, from, text: 'pay' } })
      await webhook({ callback_query: { id: 'cb', from, data: 'confirm:abcdef', message: { chat: { id: 42, type: 'private' }, message_id: 2 } } })
    }
    assert.deepEqual(calls, [])
    const valid = { message: { message_id: 3, chat: { id: 42, type: 'private' }, from: { id: 42 }, text: 'my balance' } }
    assert.equal((await webhook(valid, 'wrong-secret')).status, 401)
    await webhook(valid)
    await webhook({ callback_query: { id: 'cb', from: { id: 42 }, data: 'confirm:abcdef', message: { chat: { id: 42, type: 'private' }, message_id: 3 } } })
    assert.deepEqual(calls, ['message', 'confirm'])
    await assert.rejects(users.linkTelegram(user.id, '-99'), /private chat/)
  } finally { Object.assign(agent, { handleMessage: originals.handleMessage, resolvePending: originals.resolvePending }); for (const key of ['sendMessage', 'sendTyping', 'answerCallback', 'editKeyboard']) telegram[key] = originals[key] }
})

test('scheduled Telegram notices never send to a legacy group', async () => {
  const original = global.fetch
  process.env.TELEGRAM_BOT_TOKEN = 'test-token'
  global.fetch = async () => { throw new Error('A group message must never reach Telegram') }
  try { assert.equal(await telegram.sendMessage('-123', 'private account data'), null) }
  finally { global.fetch = original; delete process.env.TELEGRAM_BOT_TOKEN }
})

test('startup rejects mixed modes and demo deployments carrying live credentials', () => {
  const saved = { ...process.env }
  try {
    process.env.FALCONPAY_API_KEY = 'sk_live_test'
    assert.throws(env.assertSafeRuntime, /Demo deployments/)
    process.env.TOPUP_PROVIDER = 'falconpay'
    assert.throws(env.assertSafeRuntime, /simulated G\$/)
    delete process.env.FALCONPAY_API_KEY
    process.env.CHAIN_MODE = 'celo'
    assert.throws(env.assertSafeRuntime, /simulated bill provider/)
    process.env.TOPUP_PROVIDER = 'mock'
    env.assertSafeRuntime()
    process.env.NODE_ENV = 'development'
    delete process.env.WALLET_ENCRYPTION_KEY
    assert.throws(env.assertSafeRuntime, /64 hex/)
    assert.throws(localKek, /64 hex/)
    process.env.CHAIN_MODE = 'mock'
    env.assertSafeRuntime()
    assert.equal(localKek().length, 32)
  } finally { for (const key of Object.keys(process.env)) if (!(key in saved)) delete process.env[key]; Object.assign(process.env, saved) }
})

test('database mode cannot change in either direction and preserves account data', async () => {
  const count = Number((await run('SELECT COUNT(*) AS n FROM users')).rows[0].n)
  await restart()
  process.env.CHAIN_MODE = 'celo'
  await assert.rejects(db(), /separate database/)
  process.env.CHAIN_MODE = 'mock'
  assert.equal(Number((await run('SELECT COUNT(*) AS n FROM users')).rows[0].n), count)
  await run("UPDATE meta SET value = 'celo' WHERE key = 'chain_mode'")
  await restart()
  await assert.rejects(db(), /separate database/)
  process.env.CHAIN_MODE = 'celo'
  await run("UPDATE meta SET value = 'mock' WHERE key = 'chain_mode'")
  await restart()
  process.env.CHAIN_MODE = 'mock'
})

test('existing recurring consent is reset once, and group credentials are revoked', async () => {
  const user = await users.createUser({ tgChatId: '-123' })
  await run('UPDATE jars SET auto_pay = 1 WHERE user_id = ?', [user.id])
  await run('INSERT INTO agent_jobs(user_id, exam_on, scout_on) VALUES (?, 1, 1)', [user.id])
  await run("DELETE FROM meta WHERE key = 'consent_reset_v1'")
  await restart()
  const fresh = await users.getUserById(user.id)
  assert.equal(fresh.tgChatId, null)
  assert.notEqual(fresh.sessionToken, user.sessionToken)
  assert.notEqual(fresh.linkCode, user.linkCode)
  assert.equal(Number((await run('SELECT SUM(auto_pay) AS n FROM jars WHERE user_id = ?', [user.id])).rows[0].n), 0)
  const jobs = (await run('SELECT exam_on, scout_on FROM agent_jobs WHERE user_id = ?', [user.id])).rows[0]
  assert.equal(jobs.exam_on, 0); assert.equal(jobs.scout_on, 0)
  await run('UPDATE jars SET auto_pay = 1 WHERE user_id = ?', [user.id])
  await restart()
  assert.equal(Number((await run('SELECT SUM(auto_pay) AS n FROM jars WHERE user_id = ?', [user.id])).rows[0].n), 4)
})

test('global referral budget includes simultaneous reservations, retries and history', async () => {
  Object.assign(process.env, { REFERRAL_CAMPAIGN_BUDGET_GD: '3000', REFERRAL_DAILY_BUDGET_GD: '1000' })
  const results = await Promise.all(['a', 'b', 'c'].map(id => reserveReferralBudget(`reward:${id}:referral-id-test`, 1000)))
  assert.equal(results.filter(Boolean).length, 1)
  const winner = ['a', 'b', 'c'][results.indexOf(true)]
  await restart()
  assert.equal(await reserveReferralBudget(`reward:${winner}:referral-id-test`, 1000), true)
  await assert.rejects(reserveReferralBudget(`reward:${winner}:referral-id-test`, 2000), /amount changed/)
  await run('UPDATE referral_budget SET created_at = 0')
  assert.equal(await reserveReferralBudget('reward:next:referral-id-test', 1000), true)
  const user = await users.createUser()
  await run("INSERT INTO rewards_paid VALUES (?, 'referral-u_old', 1000, 0)", [user.id])
  await restart()
  process.env.REFERRAL_DAILY_BUDGET_GD = '10000'
  assert.equal(await reserveReferralBudget('reward:over:referral-id-test', 1000), false)
  assert.equal(Number((await run('SELECT SUM(amount_gd) AS n FROM referral_budget')).rows[0].n), 3000)
})

test('a sign-in link is consumed atomically across simultaneous requests and stays consumed after restart', async () => {
  const user = await users.createUser()
  const results = await Promise.all(Array.from({ length: 5 }, () => users.consumeLinkCode(user.linkCode)))
  assert.equal(results.filter(Boolean).length, 1)
  assert.equal(results.find(Boolean).id, user.id)
  await restart()
  assert.equal(await users.consumeLinkCode(user.linkCode), null)
  const fresh = await users.getUserById(user.id)
  assert.notEqual(fresh.linkCode, user.linkCode)
  assert.equal((await users.consumeLinkCode(fresh.linkCode)).id, user.id)
})

after(async () => { (await db()).close(); rmSync(directory, { recursive: true, force: true }) })
