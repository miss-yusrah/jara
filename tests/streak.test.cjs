/* eslint-disable @typescript-eslint/no-require-imports */
const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const { createHash } = require('node:crypto')
const directory = mkdtempSync(`${tmpdir()}/jara-streak-`)
const HOUR = 3_600_000
Object.assign(process.env, {
  DATABASE_URL: `file:${directory}/test.db`, CHAIN_MODE: 'mock', TOPUP_PROVIDER: 'mock', GD_NGN_RATE: '0.2', CRON_SECRET: 'cron',
  STREAK_EVENT_ID: 'test-streak', STREAK_START_AT: String(Date.now() - HOUR), STREAK_END_AT: String(Date.now() + HOUR),
  STREAK_PRIZE_POOL_GD: '100000', STREAK_PRIZE_SPLIT: '40,35,25', STREAK_RUNS_PER_WINDOW: '5', STREAK_RUN_WINDOW_MINUTES: '60', STREAK_RUNS_PER_FRIEND: '3', STREAK_MAX_FRIEND_RUNS: '30',
  STREAK_GOLDEN_HOURS: '', STREAK_GOLDEN_MINUTES: '15', STREAK_REQUIRE_FLOWSTATE: 'false',
  STREAK_PER_CORRECT_GD: '20', STREAK_POOL_CAP_GD: '100000', STREAK_DAILY_CAP_GD: '100',
})
const { db, run } = require('../src/lib/db.ts')
const users = require('../src/lib/users.ts')
const chain = require('../src/lib/chain.ts')
const streak = require('../src/lib/streak/service.ts')
const rules = require('../src/lib/streak/rules.ts')
const { STREAK_QUESTIONS } = require('../src/lib/streak/questions.ts')
const { CAMPUSES } = require('../src/lib/streak/campuses.ts')

const rootFor = (seed) => `0x${createHash('sha256').update(seed).digest('hex').slice(0, 40)}`
async function player(root, extra = {}) {
  const user = await users.createUser()
  await users.updateUser(user.id, { connected: true, rootAddress: root ?? rootFor(user.id) })
  if (extra.referredBy) await run('UPDATE users SET referred_by = ? WHERE id = ?', [extra.referredBy, user.id])
  if (extra.join === false) return users.getUserById(user.id)
  await streak.joinStreak(await users.getUserById(user.id), { campus: extra.campus ?? 'UNILAG', name: 'Test Player' })
  return users.getUserById(user.id)
}
/** Test-only: reads the server's key to find the right (or wrong) option for the question in play. */
async function choiceFor(view, right = true) {
  const a = (await run('SELECT flipped FROM streak_answers WHERE run_id = ? AND idx = ?', [view.runId, view.question.index])).rows[0]
  const correct = Number(a.flipped) ? 1 : 0
  return right ? correct : 1 - correct
}
async function correctRun(user, n) {
  let view = await streak.startRun(user)
  for (let i = 0; i < n; i++) view = (await streak.answer(user, { runId: view.runId, index: view.question.index, choice: await choiceFor(view) })).run
  return view
}

test('the bank: many distinct, well-formed questions, the right answer never hard-coded to one side', () => {
  assert.ok(STREAK_QUESTIONS.length >= 300, `only ${STREAK_QUESTIONS.length} questions`)
  assert.equal(new Set(STREAK_QUESTIONS.map((q) => q.id)).size, STREAK_QUESTIONS.length)
  for (const q of STREAK_QUESTIONS) {
    assert.equal(q.options.length, 2, q.id)
    assert.notEqual(q.options[0].trim(), q.options[1].trim(), q.id)
    assert.ok(q.prompt.trim().length > 3, q.id)
  }
  assert.ok(CAMPUSES.includes('UNILAG'))
})

test('scoring: faster scores more, combos multiply, Golden Hour doubles, the clock shrinks to 4s', () => {
  assert.equal(rules.points(0, 7000, 1, false), 150)
  assert.equal(rules.points(7000, 7000, 1, false), 100)
  assert.equal(rules.points(0, 7000, 5, false), 300)
  assert.equal(rules.points(0, 7000, 10, false), 450)
  assert.equal(rules.points(0, 7000, 20, true), 1200)
  assert.equal(rules.questionMs(0), 7000)
  assert.equal(rules.questionMs(5), 6000)
  assert.equal(rules.questionMs(50), 4000)
  assert.equal(rules.lagosDay(Date.UTC(2026, 10, 27, 23, 30)), '2026-11-28') // 00:30 in Lagos
})

test('a run never reveals the answer, resumes instead of restarting, and one identity plays from one account', async () => {
  const user = await player()
  const view = await streak.startRun(user)
  assert.equal(view.question.index, 0)
  assert.equal(view.question.options.length, 2)
  assert.equal(JSON.stringify(view).match(/flipped|correct/), null)
  assert.equal((await streak.startRun(user)).runId, view.runId)
  const second = await player(user.rootAddress, { join: false })
  await assert.rejects(streak.startRun(second, { campus: 'UNILAG' }), (err) => err.code === 'played_elsewhere')
  // A school is required before the first run; a name too when the account has none.
  const fresh = await player(undefined, { join: false })
  await assert.rejects(streak.startRun(fresh), (err) => err.code === 'needs_campus')
  await assert.rejects(streak.joinStreak(fresh, { campus: 'UNILAG' }), (err) => err.code === 'needs_name')
  const joined = await streak.joinStreak(fresh, { campus: 'UNILAG', name: 'Ada Obi' })
  assert.equal(joined.campus, 'UNILAG')
  assert.equal(joined.name, 'Ada Obi')
})

test('right answers build the streak and score once; a wrong answer ends the run and the best run stays', async () => {
  const user = await player()
  let view = await streak.startRun(user)
  const right = await choiceFor(view)
  const first = await streak.answer(user, { runId: view.runId, index: 0, choice: right })
  assert.equal(first.result.correct, true)
  assert.ok(first.result.points >= 100 && first.result.points <= 150)
  assert.equal(first.result.newBest, true)
  // A double tap or retry of the same answer scores nothing more.
  const replay = await streak.answer(user, { runId: view.runId, index: 0, choice: right })
  assert.equal(replay.result, null)
  assert.equal(replay.run.score, first.run.score)
  view = first.run
  for (let i = 0; i < 4; i++) view = (await streak.answer(user, { runId: view.runId, index: view.question.index, choice: await choiceFor(view) })).run
  assert.equal(view.streak, 5)
  const best = view.score
  const wrong = await streak.answer(user, { runId: view.runId, index: view.question.index, choice: await choiceFor(view, false) })
  assert.equal(wrong.result.correct, false)
  assert.equal(wrong.run.finished, true)
  assert.equal(wrong.run.ended, 'wrong')
  assert.equal(wrong.run.score, best)
  // A worse second run does not lower the best.
  const next = await correctRun(user, 1)
  await streak.answer(user, { runId: next.runId, index: next.question.index, choice: await choiceFor(next, false) })
  const board = await streak.leaderboard(user)
  assert.equal(board.you.score, best)
  assert.equal(board.you.streak, 5)
})

test('running out of time ends the run, but not before the server’s own deadline', async () => {
  const user = await player()
  const view = await streak.startRun(user)
  const early = await streak.answer(user, { runId: view.runId, index: 0, timeout: true })
  assert.equal(early.result, null)
  assert.equal(early.run.finished, false)
  await run('UPDATE streak_answers SET deadline = ? WHERE run_id = ? AND idx = 0', [Date.now() - 5000, view.runId])
  // Even a correct answer after the deadline (plus the network allowance) is too late.
  const late = await streak.answer(user, { runId: view.runId, index: 0, choice: await choiceFor(view) })
  assert.equal(late.result.timedOut, true)
  assert.equal(late.run.finished, true)
  assert.equal(late.run.ended, 'timeout')
})

test('runs refill: 5 at a time, +3 per verified friend, and used runs come back as time passes', async () => {
  const user = await player()
  for (let i = 0; i < 5; i++) {
    const v = await streak.startRun(user)
    await streak.answer(user, { runId: v.runId, index: 0, choice: await choiceFor(v, false) })
  }
  await assert.rejects(streak.startRun(user), (err) => err.code === 'no_runs')
  // A friend who joined but has not verified does not count; one who did gives +3 runs.
  const unverified = await users.createUser()
  await run('UPDATE users SET referred_by = ? WHERE id = ?', [user.id, unverified.id])
  await assert.rejects(streak.startRun(user), (err) => err.code === 'no_runs')
  const friend = await player(undefined, { referredBy: user.id })
  // The same person on a second account is still one friend.
  await player(friend.rootAddress, { referredBy: user.id, join: false })
  let home = await streak.streakHome(user)
  assert.equal(home.runs.friends, 1)
  assert.equal(home.runs.left, 3)
  for (let i = 0; i < 3; i++) {
    const v = await streak.startRun(user)
    await streak.answer(user, { runId: v.runId, index: 0, choice: await choiceFor(v, false) })
  }
  await assert.rejects(streak.startRun(user), (err) => err.code === 'no_runs' && /unlocks in about/.test(err.message))
  home = await streak.streakHome(user)
  assert.equal(home.runs.left, 0)
  assert.ok(home.runs.nextAt > Date.now(), 'tells the player when the next run unlocks')
  // An hour later the oldest runs have aged out of the window: the player can play again.
  await run('UPDATE streak_runs SET started_at = started_at - ? WHERE user_id = ?', [61 * 60_000, user.id])
  home = await streak.streakHome(user)
  assert.equal(home.runs.left, 8)
  assert.equal(home.runs.nextAt, null)
  const again = await streak.startRun(user)
  assert.equal(again.finished, false)
})

test('Golden Hour doubles the points of a correct answer', async () => {
  process.env.STREAK_GOLDEN_HOURS = String(Date.now() - 60_000)
  try {
    const user = await player()
    const view = await streak.startRun(user)
    const res = await streak.answer(user, { runId: view.runId, index: 0, choice: await choiceFor(view) })
    assert.equal(res.result.golden, true)
    assert.ok(res.result.points >= 200 && res.result.points <= 300)
    assert.equal((await streak.streakHome(user)).event.golden.live, true)
  } finally { process.env.STREAK_GOLDEN_HOURS = '' }
})

test('campus: picked once, and campuses rank by their players’ best scores', async () => {
  const user = await player(undefined, { campus: 'UNILAG' })
  // Any typed school is accepted (the list is only suggestions); only empty/garbage is rejected.
  await assert.rejects(streak.joinStreak(user, { campus: '!' }), (err) => err.code === 'needs_campus')
  const custom = await player(undefined, { campus: 'Some Small Private Uni' })
  assert.equal((await streak.streakHome(custom)).campus, 'Some Small Private Uni')
  await streak.joinStreak(user, { campus: 'OAU (Ife)' })
  assert.equal((await streak.streakHome(user)).campus, 'UNILAG')
  await correctRun(user, 2)
  const board = await streak.leaderboard(null)
  assert.ok(board.campuses.some((c) => c.campus === 'UNILAG' && c.score > 0))
})

test('G$ 20 per correct answer: shown at once, sent to the wallet once when the run ends, capped per day', async () => {
  const user = await player()
  const before = Number(await chain.gdBalance(user.rootAddress)) / 1e18
  let view = await streak.startRun(user)
  const first = await streak.answer(user, { runId: view.runId, index: 0, choice: await choiceFor(view) })
  assert.equal(first.result.gd, 20)
  assert.equal(first.run.earnedGd, 20)
  view = first.run
  for (let i = 0; i < 6; i++) view = (await streak.answer(user, { runId: view.runId, index: view.question.index, choice: await choiceFor(view) })).run
  // Daily cap of G$ 100: the 6th and 7th correct answers still score points but earn no G$.
  assert.equal(view.earnedGd, 100)
  assert.equal(view.streak, 7)
  // Nothing is sent mid-run.
  assert.equal(await streak.payRunEarnings(view.runId), 'open')
  const end = await streak.answer(user, { runId: view.runId, index: view.question.index, choice: await choiceFor(view, false) })
  assert.equal(end.run.finished, true)
  assert.equal(await streak.payRunEarnings(view.runId), 'paid')
  assert.equal(await streak.payRunEarnings(view.runId), 'paid')
  await streak.settlePlayer(user)
  await streak.settleEarnings()
  assert.equal(Math.round(Number(await chain.gdBalance(user.rootAddress)) / 1e18 - before), 100)
  assert.equal((await run("SELECT COUNT(*) AS n FROM activity WHERE user_id = ? AND title LIKE '%Jara Streak: %correct%'", [user.id])).rows[0].n, 1)
  // An abandoned run (the player closed the app mid-question) is paid by the cron once it times out.
  const other = await player()
  const v = await streak.startRun(other)
  const a = await streak.answer(other, { runId: v.runId, index: 0, choice: await choiceFor(v) })
  await run('UPDATE streak_answers SET deadline = ? WHERE run_id = ? AND idx = ?', [Date.now() - 10_000, v.runId, a.run.question.index])
  await streak.settleEarnings()
  assert.equal((await run('SELECT paid_at FROM streak_runs WHERE id = ?', [v.runId])).rows[0].paid_at > 0, true)
  const report = await streak.streakReport()
  assert.ok(report.answerGd.sent >= 120)
  assert.ok(report.campuses.some((c) => c.campus === 'UNILAG'))
})

test('the top 3 split the G$ 100,000 pool 40/35/25, claim it once, only after the end', async () => {
  const leaders = []
  for (const n of [12, 11, 10]) { const u = await player(); await correctRun(u, n); leaders.push(u) }
  const fourth = await player(); await correctRun(fourth, 1)
  assert.equal((await streak.finalizeWinners()).status, 'not_closed')
  await assert.rejects(streak.claimPrize(leaders[0]), (err) => err.code === 'streak_open')
  const balance = async (u) => Number(await chain.gdBalance(u.rootAddress)) / 1e18
  const before = await Promise.all(leaders.map(balance))
  process.env.STREAK_END_AT = String(Date.now() - 1000)
  try {
    const out = await streak.finalizeWinners()
    assert.equal(out.status, 'frozen')
    assert.deepEqual(out.prizes.map((p) => [p.rank, p.amountGd, p.claimed]), [[1, 40_000, false], [2, 35_000, false], [3, 25_000, false]])
    const winners = (await run("SELECT user_id FROM streak_prizes WHERE event_id = 'test-streak' ORDER BY rank")).rows.map((r) => r.user_id)
    assert.deepEqual(winners, leaders.map((u) => u.id))
    // Nothing is sent until the winner claims.
    assert.deepEqual((await Promise.all(leaders.map(balance))).map((b, i) => Math.round(b - before[i])), [0, 0, 0])
    const home = await streak.streakHome(leaders[0])
    assert.deepEqual(home.prize, { rank: 1, amountGd: 40_000, claimed: false, txHash: null })
    assert.equal(home.event.prizePoolGd, 100_000)
    assert.deepEqual(home.event.prizesGd, [40_000, 35_000, 25_000])
    const claimed = await streak.claimPrize(leaders[0])
    assert.equal(claimed.prize.claimed, true)
    // Claiming again (double tap, retry) sends nothing more; a non-winner has nothing to claim.
    await streak.claimPrize(leaders[0])
    await assert.rejects(streak.claimPrize(fourth), (err) => err.code === 'no_prize')
    await streak.finalizeWinners()
    assert.deepEqual((await Promise.all(leaders.map(balance))).map((b, i) => Math.round(b - before[i])), [40_000, 0, 0])
    assert.equal((await run("SELECT COUNT(*) AS n FROM activity WHERE type = 'reward' AND title LIKE '%Jara Streak: #%'")).rows[0].n, 1)
    await assert.rejects(streak.startRun(leaders[1]), (err) => err.code === 'streak_closed')
  } finally { process.env.STREAK_END_AT = String(Date.now() + HOUR) }
})

after(async () => { (await db()).close(); rmSync(directory, { recursive: true, force: true }) })
