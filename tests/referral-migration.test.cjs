/* eslint-disable @typescript-eslint/no-require-imports */
const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const directory = mkdtempSync(`${tmpdir()}/jara-referral-migration-`)
Object.assign(process.env, { DATABASE_URL: `file:${directory}/test.db`, CHAIN_MODE: 'mock', TOPUP_PROVIDER: 'mock' })
const { db, run } = require('../src/lib/db.ts')
const { createUser, updateUser } = require('../src/lib/users.ts')

test('startup backfills existing referral rewards with a literal underscore in the account prefix', async () => {
  const referrer = await createUser()
  const referred = await createUser()
  const root = '0xABCDEFabcdefabcdefabcdefabcdefabcdefabcd'
  await updateUser(referred.id, { rootAddress: root, connected: true })
  await run('INSERT INTO rewards_paid (user_id, reward_key, amount_gd, created_at) VALUES (?, ?, 1000, 123)', [referrer.id, `referral-${referred.id}`])
  // Startup must evaluate the migration against populated tables, not just an empty fixture.
  ;(await db()).close()
  global.__jaraDb = undefined
  const migrated = (await run('SELECT * FROM referral_identities')).rows
  assert.equal(migrated.length, 1)
  assert.equal(migrated[0].root_address, root.toLowerCase())
  assert.equal(migrated[0].referrer_id, referrer.id)
  assert.equal(migrated[0].referred_user_id, referred.id)
  ;(await db()).close()
  global.__jaraDb = undefined
  assert.equal((await run('SELECT * FROM referral_identities')).rows.length, 1, 'startup remains idempotent')
})
after(async () => { (await db()).close(); rmSync(directory, { recursive: true, force: true }) })
