/* eslint-disable @typescript-eslint/no-require-imports */
const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const directory = mkdtempSync(`${tmpdir()}/jara-referral-list-`)
Object.assign(process.env, { DATABASE_URL: `file:${directory}/test.db`, CHAIN_MODE: 'mock', TOPUP_PROVIDER: 'mock' })
const { db, run } = require('../src/lib/db.ts')
const { createUser, updateUser, getUserById, getUserByRefCode, ensureRefCode } = require('../src/lib/users.ts')
const { listReferrals } = require('../src/lib/rewards.ts')

test('referrer sees who joined with their link and where each one is', async () => {
  const referrer = await createUser({ name: 'Ada' })
  const code = await ensureRefCode(referrer)
  assert.equal((await getUserByRefCode(code)).id, referrer.id)
  assert.deepEqual(await listReferrals(referrer), [])

  const joined = await createUser({ name: 'Bola', referredBy: referrer.id })
  const verified = await createUser({ name: 'Chi', referredBy: referrer.id })
  const rewarded = await createUser({ referredBy: referrer.id })
  await createUser({ name: 'Stranger' })
  await updateUser(verified.id, { rootAddress: '0x1111111111111111111111111111111111111111', connected: true })
  const root = '0x2222222222222222222222222222222222222222'
  await updateUser(rewarded.id, { rootAddress: root, connected: true })
  await run('INSERT INTO rewards_paid (user_id, reward_key, amount_gd, created_at) VALUES (?, ?, 1000, ?)', [referrer.id, `referral-id-${root}`, Date.now()])

  const list = await listReferrals((await getUserById(referrer.id)))
  const byName = Object.fromEntries(list.map((r) => [r.name, r.status]))
  assert.equal(list.length, 3)
  assert.deepEqual(byName, { Bola: 'joined', Chi: 'verified', 'A friend': 'rewarded' })
  assert.ok(list.every((r) => !('rootAddress' in r) && typeof r.joinedAt === 'number'), 'no wallets are shown')
  assert.equal(joined.referredBy, referrer.id)
})
after(async () => { (await db()).close(); rmSync(directory, { recursive: true, force: true }) })
