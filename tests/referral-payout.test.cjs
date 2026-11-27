/* eslint-disable @typescript-eslint/no-require-imports */
const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { createHash } = require('node:crypto')
const directory = mkdtempSync(`${tmpdir()}/jara-refpay-`)
Object.assign(process.env, {
  DATABASE_URL: `file:${directory}/test.db`, CHAIN_MODE: 'mock', TOPUP_PROVIDER: 'mock', GD_NGN_RATE: '1',
  REFERRAL_MILESTONE_FRIENDS: '10', REFERRAL_MILESTONE_NGN: '5000', REFERRAL_CAMPAIGN_BUDGET_GD: '1000000', REFERRAL_DAILY_BUDGET_GD: '1000000',
})
const { formatEther } = require('viem')
const { db, run, referralStartingLine } = require('../src/lib/db.ts')
const users = require('../src/lib/users.ts')
const chain = require('../src/lib/chain.ts')
const { withUserLock } = require('../src/lib/jars.ts')
const payout = require('../src/lib/referral-payout.ts')
const rewards = require('../src/lib/rewards.ts')

const rootOf = (id) => `0x${createHash('sha256').update(id).digest('hex').slice(0, 40)}`
async function person(referredBy) {
  const user = await users.createUser()
  await users.updateUser(user.id, { connected: true, name: 'Ada Okafor', rootAddress: rootOf(user.id), ...(referredBy ? { referredBy } : {}) })
  if (referredBy) await run('UPDATE users SET referred_by = ? WHERE id = ?', [referredBy, user.id])
  return users.getUserById(user.id)
}
/** Verified friends, as the daily reward run records them (one per GoodDollar identity). */
async function friends(user, n) {
  const have = Number((await run('SELECT COUNT(*) AS n FROM referral_identities WHERE referrer_id = ?', [user.id])).rows[0].n)
  for (let i = have; i < n; i++) {
    const friend = await users.createUser()
    await run('INSERT INTO referral_identities (root_address, referrer_id, referred_user_id, created_at) VALUES (?, ?, ?, ?)', [rootOf(friend.id), user.id, friend.id, Date.now()])
  }
}
const wallet = async (user) => Math.round(Number(formatEther(await chain.gdBalance(user.rootAddress))))
const pay = (user) => withUserLock(user.id, () => payout.payReferralMilestones(user))
const milestoneActivity = async (user) => (await run("SELECT title FROM activity WHERE user_id = ? AND operation_id LIKE 'referral-milestone:%'", [user.id])).rows.map((r) => r.title)

test('nothing before 10 friends; at 10, G$ worth ₦5,000 lands in their own wallet automatically, once', async () => {
  const user = await person()
  await friends(user, 9)
  assert.deepEqual(await pay(user), [])
  let s = await payout.referralRewardState(user)
  assert.deepEqual([s.enabled, s.verifiedFriends, s.towardNext, s.rewardGd, s.sent.length], [true, 9, 9, 5000, 0])

  await friends(user, 10)
  assert.deepEqual(await pay(user), [{ friends: 10, amountGd: 5000 }])
  assert.equal(await wallet(user), 5000)
  assert.deepEqual(await pay(user), [], 'never twice')
  assert.equal(await wallet(user), 5000)
  s = await payout.referralRewardState(user)
  assert.deepEqual([s.verifiedFriends, s.towardNext, s.sent.length, s.sent[0].friends, s.sent[0].amountGd], [10, 0, 1, 10, 5000])
  assert.deepEqual(await milestoneActivity(user), ['🎉 10 friends invited: G$ 5,000 (≈ ₦5,000) sent to your wallet'])
})

test('13 friends shows 13 and pays nothing more; 20 pays again; a jump to 45 pays 30 and 40', async () => {
  const user = await person()
  await friends(user, 13)
  await pay(user)
  let s = await payout.referralRewardState(user)
  assert.deepEqual([s.verifiedFriends, s.towardNext, s.sent.length], [13, 3, 1])
  await friends(user, 20)
  assert.deepEqual((await pay(user)).map((p) => p.friends), [20])
  await friends(user, 45)
  assert.deepEqual((await pay(user)).map((p) => p.friends), [30, 40])
  assert.equal(await wallet(user), 20000)
  s = await payout.referralRewardState(user)
  assert.deepEqual([s.verifiedFriends, s.towardNext, s.sent.length], [45, 5, 4])
})

test('the G$ amount follows the price when earned and stays fixed through retries', async () => {
  const user = await person()
  await friends(user, 10)
  const original = chain.sendGdFromReferralWallet
  let calls = 0
  chain.sendGdFromReferralWallet = async () => { calls++; throw new Error('referral wallet is out of CELO') }
  process.env.GD_NGN_RATE = '0.15'
  try {
    assert.deepEqual(await pay(user), [])
    const s = await payout.referralRewardState(user)
    // ₦5,000 at ₦0.15 per G$ = G$ 33,333, rounded to G$ 33,300.
    assert.deepEqual([s.sending.length, s.sending[0].amountGd, s.sent.length], [1, 33300, 0])
  } finally { chain.sendGdFromReferralWallet = original }
  process.env.GD_NGN_RATE = '0.3'
  try {
    assert.deepEqual(await pay(user), [{ friends: 10, amountGd: 33300 }], 'the amount fixed when earned')
    assert.equal(await wallet(user), 33300)
    assert.equal(calls, 1)
  } finally { process.env.GD_NGN_RATE = '1' }
})

test('two checks at once pay one reward', async () => {
  const user = await person()
  await friends(user, 10)
  // The account lock lets one through; the others are told to retry. Either way, one payout.
  await Promise.allSettled([pay(user), pay(user), pay(user)])
  await pay(user)
  assert.equal(await wallet(user), 5000)
})

test('fully automatic: friends verify, and the per-minute check pays G$ 100 each plus the 10-friend reward', async () => {
  const referrer = await person()
  for (let i = 0; i < 10; i++) await person(referrer.id)
  const perFriend = async () => Number((await run("SELECT COUNT(*) AS n FROM rewards_paid WHERE user_id = ? AND reward_key LIKE 'referral-id-%'", [referrer.id])).rows[0].n)
  assert.equal(await rewards.payDueReferralMilestones() >= 1, true)
  // G$ 100 per verified friend, as before (to wherever Jara sends this account's rewards)…
  assert.equal(await perFriend(), 10)
  // …and the 10-friend reward straight to their own GoodDollar wallet, where GoodCash can reach it.
  assert.equal(await wallet(referrer), 5000)
  assert.equal((await payout.referralRewardState(referrer)).sent.length, 1)
  // Nothing new: a second sweep pays nobody.
  assert.equal(await rewards.payDueReferralMilestones(), 0)
  assert.equal(await perFriend(), 10)
  assert.equal(await wallet(referrer), 5000)
})

test('starting line: sets of 10 people already had before launch count as paid, once; each new 10 pays', async () => {
  const early = await person(), fresh = await person()
  await friends(early, 13)
  await friends(fresh, 4)
  const client = await db()
  assert.ok(await referralStartingLine(client, 'test-baseline') >= 1)
  assert.equal(await referralStartingLine(client, 'test-baseline'), 0, 'runs once, ever')
  assert.deepEqual(await pay(early), [])
  let s = await payout.referralRewardState(early)
  assert.deepEqual([s.verifiedFriends, s.towardNext, s.earlier, s.sent.length], [13, 3, 1, 0])
  await friends(early, 20)
  assert.deepEqual((await pay(early)).map((p) => p.friends), [20])
  await friends(fresh, 10)
  assert.deepEqual((await pay(fresh)).map((p) => p.friends), [10])
})

test('switched off with no amount', async () => {
  const user = await person()
  await friends(user, 10)
  process.env.REFERRAL_MILESTONE_NGN = '0'
  try {
    assert.equal((await payout.referralRewardState(user)).enabled, false)
    assert.deepEqual(await pay(user), [])
    assert.equal(await wallet(user), 0)
  } finally { process.env.REFERRAL_MILESTONE_NGN = '5000' }
})

after(async () => {
  ;(await db()).close()
  rmSync(directory, { recursive: true, force: true })
})
