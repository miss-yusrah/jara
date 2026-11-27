import { randomInt, randomUUID } from 'node:crypto'
import { parseEther, type Address } from 'viem'
import { gdBalance, sendGdFromStreakWallet, streakWalletAddress } from '../chain'
import { atomic, run } from '../db'
import { serverConfig } from '../env'
import { withUserLock } from '../jars'
import { ensureRefCode, getUserById, type User } from '../users'
import { authorizedUser } from '../wallet-authorization'
import { cleanCampus } from './campuses'
import * as gate from './gate'
import { STREAK_QUESTIONS, type StreakQuestion } from './questions'
import { lagosDay, multiplier, points, questionMs } from './rules'

// Jara Streak, the campus bounty: how many can you get right in a row?
//
// The server owns the clock. Each question gets a deadline when it is issued; a wrong answer, or no
// answer by the deadline, ends the run. A correct answer scores 100 plus up to 50 for speed, times the
// combo (x2 from 5 in a row, x3 from 10, x4 from 20), doubled during a Golden Hour.
//
// One player per verified identity (root wallet) per event, whichever Jara account it plays from.
// Runs refill on a rolling window: up to STREAK_RUNS_PER_WINDOW runs within any
// STREAK_RUN_WINDOW_MINUTES, coming back as older runs age out, plus STREAK_RUNS_PER_FRIEND more for
// every friend who joins with their link and verifies. The leaderboard keeps each player's best run; it is
// updated on every correct answer, so a run that is abandoned still counts for what it scored.
//
// Every correct answer also earns STREAK_PER_CORRECT_GD (G$ 20 by default), credited the moment it is answered
// and sent to the player's verified wallet in one transfer when the run ends (never mid-run, so paying
// never eats into the clock). Bounded by a bounty-wide pool and a per-player daily cap.
//
// When the bounty closes, the top places are frozen once and the STREAK_PRIZE_POOL_GD is split by
// rank (STREAK_PRIZE_SPLIT: 40/35/25). Each winner claims their share; it goes to their verified wallet, exactly once. All G$
// (prizes and per-answer) comes from the streak wallet (STREAK_WALLET_PRIVATE_KEY, else the
// treasury). Everything players see is in G$.

export class StreakError extends Error {
  constructor(message: string, readonly status = 400, readonly code?: string) { super(message) }
}

/** Allowance for the answer's trip to the server after the on-screen timer ends. */
export const NETWORK_GRACE_MS = 1_500
/** Golden Hour is announced in the app this long before it starts. */
export const GOLDEN_TEASE_MS = 60 * 60_000

export type StreakPhase = 'off' | 'soon' | 'open' | 'closed'

export function streakConfig() {
  const s = serverConfig().streak
  const whole = (n: number) => Number.isSafeInteger(n) && n >= 0
  const problem = !s.startAt || !s.endAt ? 'STREAK_START_AT and STREAK_END_AT are not set'
    : s.endAt <= s.startAt ? 'STREAK_END_AT must be after STREAK_START_AT'
    : !whole(s.prizePoolGd) ? 'STREAK_PRIZE_POOL_GD must be a whole number of G$'
    : s.prizeSplit.length < 1 || s.prizeSplit.length > 20 || !s.prizeSplit.every((x) => whole(x) && x > 0) || s.prizeSplit.reduce((a, b) => a + b, 0) !== 100 ? 'STREAK_PRIZE_SPLIT must be whole percentages for 1st, 2nd, 3rd… that add up to 100 (e.g. 40,35,25)'
    : !whole(s.runsPerWindow) || s.runsPerWindow < 1 ? 'STREAK_RUNS_PER_WINDOW must be at least 1'
    : !(s.runWindowMinutes > 0) ? 'STREAK_RUN_WINDOW_MINUTES must be greater than 0'
    : !whole(s.runsPerFriend) || !whole(s.maxFriendRuns) ? 'STREAK_RUNS_PER_FRIEND and STREAK_MAX_FRIEND_RUNS must be whole numbers'
    : !(s.goldenMinutes > 0 && s.goldenMinutes <= 180) ? 'STREAK_GOLDEN_MINUTES must be 1–180'
    : !whole(s.perCorrectGd) || !whole(s.poolCapGd) || !whole(s.dailyCapGd) ? 'STREAK_PER_CORRECT_GD, STREAK_POOL_CAP_GD and STREAK_DAILY_CAP_GD must be whole numbers'
    : null
  return { ...s, winners: s.prizeSplit.length, invitesFrom: s.invitesFrom || s.startAt, configured: problem === null, problem }
}
type Config = ReturnType<typeof streakConfig>

export function streakPhase(cfg: Config = streakConfig(), now = Date.now()): StreakPhase {
  if (!cfg.configured) return 'off'
  return now < cfg.startAt ? 'soon' : now < cfg.endAt ? 'open' : 'closed'
}

/** The Golden Hour live now (points double), or the next one if it starts within ten minutes. */
export function goldenState(cfg: Config = streakConfig(), now = Date.now()) {
  const length = cfg.goldenMinutes * 60_000
  const live = cfg.goldenHours.find((g) => now >= g && now < g + length)
  if (live !== undefined) return { live: true, endsAt: live + length, startsAt: live }
  const next = cfg.goldenHours.filter((g) => g > now && g - now <= GOLDEN_TEASE_MS).sort((a, b) => a - b)[0]
  return { live: false, endsAt: next === undefined ? null : next + length, startsAt: next ?? null }
}
const goldenAt = (cfg: Config, at: number) => cfg.goldenHours.some((g) => at >= g && at < g + cfg.goldenMinutes * 60_000)

const questionById = new Map(STREAK_QUESTIONS.map((q) => [q.id, q]))
function question(id: string): StreakQuestion {
  const q = questionById.get(id)
  if (!q) throw new StreakError('This question is no longer available.', 500)
  return q
}

function shuffle<T>(items: readonly T[]): T[] {
  const pool = [...items]
  for (let i = pool.length - 1; i > 0; i--) { const j = randomInt(i + 1); [pool[i], pool[j]] = [pool[j], pool[i]] }
  return pool
}

type RunRow = { id: string; event_id: string; root_address: string; user_id: string; day: string; question_ids: string; current: number; streak: number; score: number; started_at: number; finished_at: number | null; ended: string | null; earned_gd?: number; paid_at?: number | null }

/** Per-answer G$ is on when both the amount and the bounty-wide pool are set. */
const answerGdOn = (cfg: Config) => cfg.perCorrectGd > 0 && cfg.poolCapGd > 0
type AnswerRow = { run_id: string; idx: number; question_id: string; flipped: number; issued_at: number; deadline: number; answered_at: number | null; choice: number | null; correct: number | null; points: number }
type PlayerRow = { event_id: string; root_address: string; user_id: string; campus: string | null; best_score: number; best_streak: number; best_at: number | null; runs: number }

const getRun = async (id: string) => ((await run('SELECT * FROM streak_runs WHERE id = ?', [id])).rows[0] as unknown as RunRow) ?? null
const getAnswer = async (runId: string, idx: number) => ((await run('SELECT * FROM streak_answers WHERE run_id = ? AND idx = ?', [runId, idx])).rows[0] as unknown as AnswerRow) ?? null
const getPlayer = async (eventId: string, root: string) => ((await run('SELECT * FROM streak_players WHERE event_id = ? AND root_address = ?', [eventId, root])).rows[0] as unknown as PlayerRow) ?? null

/** Questions this person has not seen this event come first, so replays stay fresh as long as possible. */
async function questionOrder(eventId: string, root: string): Promise<string[]> {
  const seen = new Set((await run(`SELECT DISTINCT a.question_id FROM streak_answers a JOIN streak_runs r ON r.id = a.run_id WHERE r.event_id = ? AND r.root_address = ?`, [eventId, root])).rows.map((r) => String(r.question_id)))
  const ids = STREAK_QUESTIONS.map((q) => q.id)
  return [...shuffle(ids.filter((id) => !seen.has(id))), ...shuffle(ids.filter((id) => seen.has(id)))]
}

async function issue(r: RunRow, idx: number, now = Date.now()) {
  const ids = JSON.parse(r.question_ids) as string[]
  await run('INSERT OR IGNORE INTO streak_answers (run_id, idx, question_id, flipped, issued_at, deadline) VALUES (?, ?, ?, ?, ?, ?)',
    [r.id, idx, ids[idx], randomInt(2), now, now + questionMs(Number(r.streak))])
}

async function finish(runId: string, ended: 'wrong' | 'timeout' | 'cleared' | 'closed' | 'replaced', now = Date.now()) {
  await run('UPDATE streak_runs SET finished_at = ?, ended = ? WHERE id = ? AND finished_at IS NULL', [now, ended, runId])
}

/** A run whose question ran out of time (plus the network allowance) is over. */
async function expireIfLate(r: RunRow, now = Date.now()): Promise<boolean> {
  if (r.finished_at) return true
  const a = await getAnswer(r.id, Number(r.current))
  if (a && a.answered_at === null && now > Number(a.deadline) + NETWORK_GRACE_MS) {
    await finish(r.id, 'timeout', Number(a.deadline))
    return true
  }
  if (now >= streakConfig().endAt) { await finish(r.id, 'closed', now); return true }
  return false
}

/** What the player sees. Never includes the answer to a question still in play. */
async function runView(runId: string) {
  const r = (await getRun(runId))!
  const a = r.finished_at ? null : await getAnswer(r.id, Number(r.current))
  const q = a ? question(a.question_id) : null
  return {
    runId: r.id,
    streak: Number(r.streak),
    score: Number(r.score),
    multiplier: multiplier(Number(r.streak) + 1),
    finished: Boolean(r.finished_at),
    earnedGd: Number(r.earned_gd ?? 0),
    paid: Boolean(r.paid_at),
    ended: r.ended as 'wrong' | 'timeout' | 'cleared' | 'closed' | 'replaced' | null,
    question: a && q ? {
      index: Number(a.idx),
      topic: q.topic,
      prompt: q.prompt,
      options: Number(a.flipped) ? [q.options[1], q.options[0]] : [q.options[0], q.options[1]],
      deadline: Number(a.deadline),
      limitMs: Number(a.deadline) - Number(a.issued_at),
      serverNow: Date.now(),
    } : null,
  }
}
export type StreakRunView = Awaited<ReturnType<typeof runView>>

/** Friends who joined with this person's link during the bounty and verified (counted once per identity). */
async function friendsJoined(user: User, cfg: Config): Promise<number> {
  const mine = user.rootAddress?.toLowerCase() ?? ''
  return Number((await run(`SELECT COUNT(DISTINCT LOWER(u.root_address)) AS n FROM users u
    WHERE u.referred_by = ? AND u.connected = 1 AND u.root_address IS NOT NULL AND LOWER(u.root_address) != ? AND u.created_at >= ?
      AND NOT EXISTS (SELECT 1 FROM referral_identities ri WHERE ri.root_address = LOWER(u.root_address) AND ri.referrer_id != ?)`,
  [user.id, mine, cfg.invitesFrom, user.id])).rows[0].n)
}

/**
 * Runs available right now. Free runs refill on a rolling window: you may start up to
 * STREAK_RUNS_PER_WINDOW runs within any STREAK_RUN_WINDOW_MINUTES, and as older runs age out of
 * that window they come back — so nobody is ever locked out for long. Inviting friends adds capacity.
 */
async function allowance(user: User, cfg: Config, now = Date.now()) {
  const root = user.rootAddress?.toLowerCase() ?? ''
  const windowMs = cfg.runWindowMinutes * 60_000
  const recent = (await run('SELECT started_at FROM streak_runs WHERE event_id = ? AND root_address = ? AND started_at >= ? ORDER BY started_at', [cfg.eventId, root, now - windowMs])).rows.map((r) => Number(r.started_at))
  const friends = await friendsJoined(user, cfg)
  const bonus = Math.min(cfg.maxFriendRuns, friends * cfg.runsPerFriend)
  const capacity = cfg.runsPerWindow + bonus
  const used = recent.length
  const left = Math.max(0, capacity - used)
  // When none are left, the next one unlocks as the oldest run in the window ages out.
  const nextAt = left > 0 || used < capacity ? null : recent[used - capacity] + windowMs
  return { capacity, perWindow: cfg.runsPerWindow, windowMinutes: cfg.runWindowMinutes, used, left, bonus, friends, runsPerFriend: cfg.runsPerFriend, maxFriendRuns: cfg.maxFriendRuns, nextAt }
}

async function activeRun(cfg: Config, root: string) {
  const row = (await run('SELECT * FROM streak_runs WHERE event_id = ? AND root_address = ? AND finished_at IS NULL ORDER BY started_at DESC LIMIT 1', [cfg.eventId, root])).rows[0] as unknown as RunRow | undefined
  if (!row || await expireIfLate(row)) return null
  return row
}

function connectedRoot(user: User): string {
  if (!user.connected || !user.rootAddress) throw new StreakError('Connect your verified GoodDollar wallet to play.', 409, 'not_connected')
  return user.rootAddress.toLowerCase()
}

/** The leaderboard name: 2–30 letters, numbers, spaces and a little punctuation. */
function cleanName(name: unknown): string | null {
  if (typeof name !== 'string') return null
  const n = name.replace(/\s+/g, ' ').trim()
  return n.length >= 2 && n.length <= 30 && /^[\p{L}\p{N} .'’-]+$/u.test(n) ? n : null
}

/** Join (once per identity). The campus is picked once; a missing name can be filled in. Returns the player. */
async function join(user: User, cfg: Config, root: string, details: { campus?: unknown; name?: unknown }) {
  await run('INSERT OR IGNORE INTO streak_players (event_id, root_address, user_id, created_at) VALUES (?, ?, ?, ?)', [cfg.eventId, root, user.id, Date.now()])
  const p = (await getPlayer(cfg.eventId, root))!
  if (p.user_id !== user.id) throw new StreakError('This GoodDollar identity already plays from another Jara account. One player per person.', 409, 'played_elsewhere')
  const campus = cleanCampus(details.campus)
  if (!p.campus && campus) {
    await run('UPDATE streak_players SET campus = ? WHERE event_id = ? AND root_address = ? AND campus IS NULL', [campus, cfg.eventId, root])
    p.campus = campus
  }
  const name = cleanName(details.name)
  if (name && !user.name?.trim()) await run("UPDATE users SET name = ? WHERE id = ? AND (name IS NULL OR TRIM(name) = '')", [name, user.id])
  return p
}

/** Sign up for the bounty: school (required, once) and, if the account has none, a name. */
export async function joinStreak(input: User, details: { campus?: unknown; name?: unknown }) {
  const cfg = streakConfig()
  if (!cleanCampus(details.campus)) throw new StreakError('Add your school (2–40 letters).', 400, 'needs_campus')
  if (!input.name?.trim() && !cleanName(details.name)) throw new StreakError('Add the name you want on the leaderboard (2–30 letters).', 400, 'needs_name')
  const root = connectedRoot(input)
  const user = await authorizedUser(input)
  await withUserLock(user.id, () => join(user, cfg, root, details), { waitMs: 10_000 })
  return streakHome((await getUserById(user.id))!)
}

export async function startRun(input: User, body: { campus?: unknown; name?: unknown } = {}) {
  const cfg = streakConfig()
  const phase = streakPhase(cfg)
  if (phase !== 'open') throw new StreakError(phase === 'soon' ? 'Jara Streak has not started yet.' : phase === 'closed' ? 'Jara Streak has ended.' : 'Jara Streak is not open.', 409, `streak_${phase}`)
  const root = connectedRoot(input)
  const user = await authorizedUser(input)
  if (cfg.requireFlowstate && !(await gate.votesForJara(user.rootAddress as Address))) throw new StreakError('Vote for Jara on Flowstate to unlock Jara Streak.', 403, 'needs_flowstate')
  return withUserLock(user.id, async () => {
    const p = await join(user, cfg, root, body)
    if (!p.campus) throw new StreakError('Pick your school first.', 409, 'needs_campus')
    const live = await activeRun(cfg, root)
    if (live) return runView(live.id)
    const left = await allowance(user, cfg)
    if (left.left <= 0) {
      const mins = left.nextAt ? Math.max(1, Math.ceil((left.nextAt - Date.now()) / 60_000)) : cfg.runWindowMinutes
      throw new StreakError(`You've used your runs for now — another unlocks in about ${mins} minute${mins === 1 ? '' : 's'}${left.bonus < left.maxFriendRuns ? ', or invite a friend for more right away' : ''}.`, 409, 'no_runs')
    }
    const now = Date.now()
    const r: RunRow = { id: randomUUID(), event_id: cfg.eventId, root_address: root, user_id: user.id, day: lagosDay(now), question_ids: JSON.stringify(await questionOrder(cfg.eventId, root)), current: 0, streak: 0, score: 0, started_at: now, finished_at: null, ended: null }
    await atomic(async (tx) => {
      await tx.execute({ sql: 'INSERT INTO streak_runs (id, event_id, root_address, user_id, day, question_ids, started_at) VALUES (?, ?, ?, ?, ?, ?, ?)', args: [r.id, r.event_id, root, user.id, r.day, r.question_ids, now] })
      await tx.execute({ sql: 'UPDATE streak_players SET runs = runs + 1 WHERE event_id = ? AND root_address = ?', args: [cfg.eventId, root] })
    })
    await issue(r, 0)
    return runView(r.id)
  }, { waitMs: 10_000 })
}

type Result = { correct: boolean; timedOut: boolean; correctChoice: number | null; points: number; golden: boolean; newBest: boolean; gd: number; gdNote: 'daily_cap' | 'pool_empty' | null }

/** { runId, index, choice } with choice 0 or 1, or { timeout: true } once the on-screen clock ran out. */
export async function answer(user: User, body: { runId?: unknown; index?: unknown; choice?: unknown; timeout?: unknown }) {
  if (typeof body.runId !== 'string') throw new StreakError('Unknown run.', 404)
  const cfg = streakConfig()
  return withUserLock(user.id, async () => {
    const r = await getRun(body.runId as string)
    if (!r || r.user_id !== user.id) throw new StreakError('Unknown run.', 404)
    const now = Date.now()
    if (r.finished_at || body.index !== Number(r.current)) return { result: null, run: await runView(r.id) }
    const a = await getAnswer(r.id, Number(r.current))
    if (!a || a.answered_at !== null) return { result: null, run: await runView(r.id) }
    question(a.question_id)
    const correctChoice = Number(a.flipped) ? 1 : 0
    const late = now > Number(a.deadline) + NETWORK_GRACE_MS
    if (body.timeout === true || late) {
      // The phone's clock can run ahead of the server's; only end the run once the deadline has truly passed.
      if (now <= Number(a.deadline)) return { result: null, run: await runView(r.id) }
      await atomic(async (tx) => {
        await tx.execute({ sql: 'UPDATE streak_answers SET answered_at = ?, correct = 0 WHERE run_id = ? AND idx = ? AND answered_at IS NULL', args: [now, r.id, a.idx] })
        await tx.execute({ sql: "UPDATE streak_runs SET finished_at = ?, ended = 'timeout' WHERE id = ? AND finished_at IS NULL", args: [now, r.id] })
      })
      return { result: { correct: false, timedOut: true, correctChoice, points: 0, golden: false, newBest: false, gd: 0, gdNote: null } satisfies Result, run: await runView(r.id) }
    }
    const choice = Number(body.choice)
    if (choice !== 0 && choice !== 1) throw new StreakError('Pick one of the two answers.')
    if (now >= cfg.endAt) { await finish(r.id, 'closed', now); return { result: null, run: await runView(r.id) } }
    const correct = choice === correctChoice
    const limit = Number(a.deadline) - Number(a.issued_at)
    const elapsed = Math.min(limit, Math.max(0, now - Number(a.issued_at)))
    const streak = Number(r.streak) + (correct ? 1 : 0)
    const golden = correct && goldenAt(cfg, now)
    const earned = correct ? points(elapsed, limit, streak, golden) : 0
    const score = Number(r.score) + earned
    const total = (JSON.parse(r.question_ids) as string[]).length
    let newBest = false
    let gd = 0
    let gdNote: Result['gdNote'] = null
    const recorded = await atomic(async (tx) => {
      // G$ for a correct answer: within the bounty pool and this player's daily cap, checked in the
      // same transaction that records the answer, so it can never be over-promised.
      if (correct && answerGdOn(cfg)) {
        const totals = (await tx.execute({ sql: `SELECT COALESCE(SUM(earned_gd), 0) AS pool, COALESCE(SUM(CASE WHEN root_address = ? AND day = ? THEN earned_gd ELSE 0 END), 0) AS today FROM streak_runs WHERE event_id = ?`, args: [r.root_address, lagosDay(now), r.event_id] })).rows[0]
        if (Number(totals.pool) + cfg.perCorrectGd > cfg.poolCapGd) gdNote = 'pool_empty'
        else if (Number(totals.today) + cfg.perCorrectGd > cfg.dailyCapGd) gdNote = 'daily_cap'
        else gd = cfg.perCorrectGd
      }
      const done = await tx.execute({ sql: 'UPDATE streak_answers SET answered_at = ?, choice = ?, correct = ?, points = ?, gd = ? WHERE run_id = ? AND idx = ? AND answered_at IS NULL', args: [now, choice, correct ? 1 : 0, earned, gd, r.id, a.idx] })
      if (!done.rowsAffected) return false
      if (!correct) {
        await tx.execute({ sql: "UPDATE streak_runs SET finished_at = ?, ended = 'wrong' WHERE id = ?", args: [now, r.id] })
        return true
      }
      const cleared = Number(r.current) + 1 >= total
      await tx.execute({ sql: `UPDATE streak_runs SET streak = ?, score = ?, earned_gd = earned_gd + ?, current = current + ?, finished_at = ?, ended = ? WHERE id = ?`, args: [streak, score, gd, cleared ? 0 : 1, cleared ? now : null, cleared ? 'cleared' : null, r.id] })
      const best = await tx.execute({ sql: 'UPDATE streak_players SET best_score = ?, best_streak = ?, best_at = ? WHERE event_id = ? AND root_address = ? AND best_score < ?', args: [score, streak, now, r.event_id, r.root_address, score] })
      newBest = best.rowsAffected > 0
      return true
    })
    if (!recorded) { gd = 0; return { result: null, run: await runView(r.id) } }
    if (correct && Number(r.current) + 1 < total) await issue({ ...r, streak }, Number(r.current) + 1)
    return { result: { correct, timedOut: false, correctChoice, points: earned, golden, newBest, gd, gdNote } satisfies Result, run: await runView(r.id) }
  }, { waitMs: 10_000 })
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
const ORDER = 'best_score DESC, best_at ASC, root_address ASC'

export async function leaderboard(viewer: User | null, limit = 20) {
  const cfg = streakConfig()
  const now = Date.now()
  // Playing right now: a run whose question in play is still on the clock (or just ran out).
  const liveSql = `EXISTS (SELECT 1 FROM streak_runs r JOIN streak_answers a ON a.run_id = r.id AND a.idx = r.current
    WHERE r.event_id = p.event_id AND r.root_address = p.root_address AND r.finished_at IS NULL AND a.answered_at IS NULL AND a.deadline > ?)`
  const rows = (await run(`SELECT p.root_address, p.campus, p.best_score, p.best_streak, u.name, ${liveSql} AS live FROM streak_players p JOIN users u ON u.id = p.user_id
    WHERE p.event_id = ? AND p.best_score > 0 ORDER BY p.best_score DESC, p.best_at ASC, p.root_address ASC LIMIT ?`, [now - 5_000, cfg.eventId, limit])).rows
  const playingNow = Number((await run(`SELECT COUNT(*) AS n FROM streak_players p WHERE p.event_id = ? AND ${liveSql}`, [cfg.eventId, now - 5_000])).rows[0].n)
  const players = Number((await run('SELECT COUNT(*) AS n FROM streak_players WHERE event_id = ? AND runs > 0', [cfg.eventId])).rows[0].n)
  const podium = (await run(`SELECT best_score FROM streak_players WHERE event_id = ? AND best_score > 0 ORDER BY ${ORDER} LIMIT 1 OFFSET ?`, [cfg.eventId, cfg.winners - 1])).rows[0]
  let you: { rank: number | null; score: number; streak: number; toPodium: number | null } | null = null
  if (viewer?.rootAddress) {
    const mine = await getPlayer(cfg.eventId, viewer.rootAddress.toLowerCase())
    if (mine && mine.user_id === viewer.id) {
      let rank: number | null = null
      if (Number(mine.best_score) > 0) {
        const ahead = (await run(`SELECT COUNT(*) AS n FROM streak_players WHERE event_id = ? AND best_score > 0 AND (best_score > ? OR (best_score = ? AND (best_at < ? OR (best_at = ? AND root_address < ?))))`,
          [cfg.eventId, mine.best_score, mine.best_score, mine.best_at, mine.best_at, mine.root_address])).rows[0]
        rank = Number(ahead.n) + 1
      }
      const toPodium = rank !== null && rank <= cfg.winners ? 0 : podium ? Number(podium.best_score) - Number(mine.best_score) + 1 : null
      you = { rank, score: Number(mine.best_score), streak: Number(mine.best_streak), toPodium }
    }
  }
  const campuses = (await run(`SELECT campus, SUM(best_score) AS score, COUNT(*) AS players FROM streak_players
    WHERE event_id = ? AND campus IS NOT NULL AND campus NOT IN ('Another school', 'Not in school') AND best_score > 0 GROUP BY campus ORDER BY score DESC LIMIT 10`, [cfg.eventId])).rows
  const prizes = (await run('SELECT rank, amount_gd, paid_at FROM streak_prizes WHERE event_id = ? ORDER BY rank', [cfg.eventId])).rows
  return {
    eventId: cfg.eventId,
    phase: streakPhase(cfg),
    players,
    playingNow,
    winners: cfg.winners,
    prizePoolGd: cfg.prizePoolGd,
    prizesGd: prizesGd(cfg),
    top: rows.map((x, i) => ({
      rank: i + 1,
      name: (x.name as string | null)?.trim().split(/\s+/).slice(0, 2).join(' ') || `Player ${short(String(x.root_address))}`,
      wallet: short(String(x.root_address)),
      campus: (x.campus as string | null) ?? null,
      score: Number(x.best_score),
      streak: Number(x.best_streak),
      live: Boolean(Number(x.live)),
      you: Boolean(viewer?.rootAddress && String(x.root_address) === viewer.rootAddress.toLowerCase()),
    })),
    you,
    campuses: campuses.map((c, i) => ({ rank: i + 1, campus: String(c.campus), score: Number(c.score), players: Number(c.players) })),
    prizes: prizes.map((p) => ({ rank: Number(p.rank), amountGd: Number(p.amount_gd), claimed: Boolean(p.paid_at) })),
  }
}
export type StreakBoard = Awaited<ReturnType<typeof leaderboard>>

/** The game screen's first load. Database reads only (plus the optional Flowstate check). */
export async function streakHome(user: User | null) {
  const cfg = streakConfig()
  const phase = streakPhase(cfg)
  const connected = Boolean(user?.connected && user.rootAddress)
  const root = connected ? user!.rootAddress!.toLowerCase() : null
  const player = root ? await getPlayer(cfg.eventId, root) : null
  const playedElsewhere = Boolean(player && player.user_id !== user!.id)
  const live = root && !playedElsewhere && phase === 'open' ? await activeRun(cfg, root) : null
  if (phase === 'closed') await finalizeWinners().catch(() => undefined)
  return {
    event: {
      eventId: cfg.eventId,
      phase,
      startAt: cfg.configured ? cfg.startAt : null,
      endAt: cfg.configured ? cfg.endAt : null,
      prizePoolGd: cfg.prizePoolGd,
      prizesGd: prizesGd(cfg),
      winners: cfg.winners,
      runsPerWindow: cfg.runsPerWindow,
      runWindowMinutes: cfg.runWindowMinutes,
      runsPerFriend: cfg.runsPerFriend,
      goldenMinutes: cfg.goldenMinutes,
      perCorrectGd: answerGdOn(cfg) ? cfg.perCorrectGd : 0,
      dailyCapGd: cfg.dailyCapGd,
      poolLeftGd: answerGdOn(cfg) ? Math.max(0, cfg.poolCapGd - Number((await run('SELECT COALESCE(SUM(earned_gd), 0) AS n FROM streak_runs WHERE event_id = ?', [cfg.eventId])).rows[0].n)) : 0,
      golden: goldenState(cfg),
      requireFlowstate: cfg.requireFlowstate,
      questions: STREAK_QUESTIONS.length,
      serverNow: Date.now(),
    },
    signedIn: Boolean(user),
    connected,
    name: user?.name?.trim() || null,
    earnedTodayGd: root ? Number((await run('SELECT COALESCE(SUM(earned_gd), 0) AS n FROM streak_runs WHERE event_id = ? AND root_address = ? AND day = ?', [cfg.eventId, root, lagosDay(Date.now())])).rows[0].n) : 0,
    earnedGd: root ? Number((await run('SELECT COALESCE(SUM(earned_gd), 0) AS n FROM streak_runs WHERE event_id = ? AND root_address = ?', [cfg.eventId, root])).rows[0].n) : 0,
    supported: !cfg.requireFlowstate || !root || Boolean(player?.runs) ? true : await gate.votesForJara(root as Address).catch(() => false),
    playedElsewhere,
    campus: player && !playedElsewhere ? player.campus : null,
    best: player && !playedElsewhere ? { score: Number(player.best_score), streak: Number(player.best_streak), runs: Number(player.runs) } : null,
    runs: user && connected && !playedElsewhere ? await allowance(user, cfg) : null,
    inviteLink: user ? `${serverConfig().appUrl}/app?ref=${await ensureRefCode(user)}` : null,
    run: live ? await runView(live.id) : null,
    prize: playedElsewhere ? null : await prizeFor(user),
  }
}
export type StreakHome = Awaited<ReturnType<typeof streakHome>>

/** Config only, for the dashboard banner. A mistyped setting hides the banner; it never breaks the app. */
export function streakBanner() {
  try {
    const cfg = streakConfig()
    const phase = streakPhase(cfg)
    if (phase === 'off') return undefined
    return { phase, startAt: cfg.startAt, endAt: cfg.endAt, prizePoolGd: cfg.prizePoolGd, prizesGd: prizesGd(cfg), winners: cfg.winners, perCorrectGd: answerGdOn(cfg) ? cfg.perCorrectGd : 0, golden: goldenState(cfg) }
  } catch (err) {
    console.error('[streak] configuration error', err instanceof Error ? err.message : err)
    return undefined
  }
}

/** The prize for each place, 1st first: the pool split by STREAK_PRIZE_SPLIT (G$ 40,000, 35,000, 25,000). */
export const prizesGd = (cfg: Config = streakConfig()) => cfg.prizeSplit.map((pct) => Math.floor((cfg.prizePoolGd * pct) / 100))

/**
 * After the bounty closes: freeze the winners, once. The cron calls this every minute; the game page
 * does too. Freezing sends nothing: each winner claims their prize themselves (claimPrize).
 */
export async function finalizeWinners() {
  const cfg = streakConfig()
  if (streakPhase(cfg) !== 'closed') return { eventId: cfg.eventId, status: 'not_closed' as const, prizes: [] }
  if (cfg.prizePoolGd <= 0) return { eventId: cfg.eventId, status: 'no_prize' as const, prizes: [] }
  const frozen = Number((await run('SELECT COUNT(*) AS n FROM streak_prizes WHERE event_id = ?', [cfg.eventId])).rows[0].n) > 0
  if (!frozen) {
    const amounts = prizesGd(cfg)
    const top = (await run(`SELECT root_address, user_id, best_score FROM streak_players WHERE event_id = ? AND best_score > 0 ORDER BY ${ORDER} LIMIT ?`, [cfg.eventId, cfg.winners])).rows
    await atomic(async (tx) => {
      if (Number((await tx.execute({ sql: 'SELECT COUNT(*) AS n FROM streak_prizes WHERE event_id = ?', args: [cfg.eventId] })).rows[0].n) > 0) return
      for (const [i, row] of top.entries()) {
        await tx.execute({ sql: 'INSERT INTO streak_prizes (event_id, rank, root_address, user_id, score, amount_gd) VALUES (?, ?, ?, ?, ?, ?)', args: [cfg.eventId, i + 1, String(row.root_address), String(row.user_id), Number(row.best_score), amounts[i]] })
      }
    })
  }
  const prizes = (await run('SELECT rank, amount_gd, paid_at FROM streak_prizes WHERE event_id = ? ORDER BY rank', [cfg.eventId])).rows
  return { eventId: cfg.eventId, status: 'frozen' as const, prizes: prizes.map((p) => ({ rank: Number(p.rank), amountGd: Number(p.amount_gd), claimed: Boolean(p.paid_at) })) }
}

/** This player's prize, if they won one. */
async function prizeFor(user: User | null) {
  if (!user?.rootAddress) return null
  const p = (await run('SELECT * FROM streak_prizes WHERE event_id = ? AND root_address = ? AND user_id = ?', [streakConfig().eventId, user.rootAddress.toLowerCase(), user.id])).rows[0]
  return p ? { rank: Number(p.rank), amountGd: Number(p.amount_gd), claimed: Boolean(p.paid_at), txHash: (p.tx_hash as string | null) ?? null } : null
}

/**
 * A winner claims their prize: it is sent to the verified wallet they played with, exactly once
 * (durable operation id; a retry replays the same transaction).
 */
export async function claimPrize(input: User) {
  const cfg = streakConfig()
  if (streakPhase(cfg) !== 'closed') throw new StreakError('Prizes can be claimed once Jara Streak ends.', 409, 'streak_open')
  await finalizeWinners()
  const user = await authorizedUser(input)
  return withUserLock(user.id, async () => {
    const prize = await prizeFor(user)
    if (!prize) throw new StreakError('There is no prize to claim on this account.', 404, 'no_prize')
    if (prize.claimed) return streakHome(user)
    const to = user.rootAddress!.toLowerCase() as Address
    const opId = `streak:${cfg.eventId}:prize:${prize.rank}:${to}`
    const amount = parseEther(String(prize.amountGd))
    let hash: string
    try { hash = await sendGdFromStreakWallet(to, amount, opId) } catch (err) {
      console.error('[streak] prize claim deferred', opId, err instanceof Error ? err.message : 'error')
      throw new StreakError('Your prize could not be sent just now. Please tap Claim again in a minute; it will only ever be sent once.', 503, 'claim_retry')
    }
    await atomic(async (tx) => {
      const paid = await tx.execute({ sql: 'UPDATE streak_prizes SET tx_hash = ?, paid_at = ? WHERE event_id = ? AND rank = ? AND paid_at IS NULL', args: [hash, Date.now(), cfg.eventId, prize.rank] })
      if (!paid.rowsAffected) return
      await tx.execute({ sql: 'INSERT OR IGNORE INTO rewards_paid (user_id, reward_key, amount_gd, created_at) VALUES (?, ?, ?, ?)', args: [user.id, `streak:${cfg.eventId}:prize`, prize.amountGd, Date.now()] })
      await tx.execute({ sql: "INSERT OR IGNORE INTO activity (user_id, type, amount_wei, tx_hash, title, operation_id, created_at) VALUES (?, 'reward', ?, ?, ?, ?, ?)", args: [user.id, String(amount), hash, `🏆 Jara Streak: #${prize.rank} on the leaderboard. G$ ${prize.amountGd.toLocaleString('en-US')} claimed to your wallet`, opId, Date.now()] })
    })
    return streakHome(user)
  }, { waitMs: 15_000 })
}

/**
 * Send a finished run's G$ (G$ 20 per correct answer) to the player's verified wallet, once: one
 * transfer per run, under a durable operation id, so a retry replays the same transaction.
 */
export async function payRunEarnings(runId: string): Promise<'paid' | 'none' | 'retry' | 'open'> {
  const r = await getRun(runId)
  if (!r) return 'none'
  if (!r.finished_at && !(await expireIfLate(r))) return 'open'
  const earned = Number(r.earned_gd ?? 0)
  if (r.paid_at || earned <= 0) return r.paid_at ? 'paid' : 'none'
  const opId = `streak:${r.event_id}:run:${r.id}`
  const to = r.root_address as Address
  try {
    const amount = parseEther(String(earned))
    const hash = await sendGdFromStreakWallet(to, amount, opId)
    const correct = Number((await run('SELECT COUNT(*) AS n FROM streak_answers WHERE run_id = ? AND gd > 0', [r.id])).rows[0].n)
    await atomic(async (tx) => {
      const paid = await tx.execute({ sql: 'UPDATE streak_runs SET paid_at = ?, tx_hash = ? WHERE id = ? AND paid_at IS NULL', args: [Date.now(), hash, r.id] })
      if (!paid.rowsAffected) return
      await tx.execute({ sql: 'INSERT OR IGNORE INTO rewards_paid (user_id, reward_key, amount_gd, created_at) VALUES (?, ?, ?, ?)', args: [r.user_id, `streak:${r.event_id}:run:${r.id}`, earned, Date.now()] })
      await tx.execute({ sql: "INSERT OR IGNORE INTO activity (user_id, type, amount_wei, tx_hash, title, operation_id, created_at) VALUES (?, 'reward', ?, ?, ?, ?, ?)", args: [r.user_id, String(amount), hash, `🔥 Jara Streak: ${correct} correct answer${correct === 1 ? '' : 's'}, G$ ${earned.toLocaleString('en-US')} sent to your wallet`, opId, Date.now()] })
    })
    return 'paid'
  } catch (err) {
    console.error('[streak] run payout deferred', opId, err instanceof Error ? err.message : 'error')
    return 'retry'
  }
}

/** This player's unpaid finished runs (after a run ends, or when they start the next). */
export async function settlePlayer(user: User) {
  const cfg = streakConfig()
  if (!user.rootAddress) return
  const due = (await run('SELECT id FROM streak_runs WHERE event_id = ? AND root_address = ? AND user_id = ? AND earned_gd > 0 AND paid_at IS NULL', [cfg.eventId, user.rootAddress.toLowerCase(), user.id])).rows
  for (const row of due) await withUserLock(user.id, () => payRunEarnings(String(row.id)), { waitMs: 15_000 }).catch(() => undefined)
}

/** Cron: every run with G$ still to send (including runs abandoned mid-question). */
export async function settleEarnings(max = 50) {
  const cfg = streakConfig()
  if (!cfg.configured) return { paid: 0, retry: 0 }
  const due = (await run('SELECT id, user_id FROM streak_runs WHERE event_id = ? AND earned_gd > 0 AND paid_at IS NULL ORDER BY started_at LIMIT ?', [cfg.eventId, max])).rows
  let paid = 0, retry = 0
  for (const row of due) {
    const out = await withUserLock(String(row.user_id), () => payRunEarnings(String(row.id)), { waitMs: 5_000 }).catch(() => 'retry' as const)
    if (out === 'paid') paid++
    if (out === 'retry') retry++
  }
  return { paid, retry }
}

/** Admin: everything accounted for. Players, schools, runs, G$ earned and sent, prizes. */
export async function streakReport() {
  const cfg = streakConfig()
  const one = async (sql: string, args: (string | number)[] = []) => (await run(sql, args)).rows[0]
  const players = await one(`SELECT COUNT(*) AS joined, COALESCE(SUM(CASE WHEN runs > 0 THEN 1 ELSE 0 END), 0) AS played, COALESCE(SUM(runs), 0) AS runs, COALESCE(MAX(best_streak), 0) AS longest FROM streak_players WHERE event_id = ?`, [cfg.eventId])
  const gd = await one(`SELECT COALESCE(SUM(earned_gd), 0) AS earned, COALESCE(SUM(CASE WHEN paid_at IS NOT NULL THEN earned_gd ELSE 0 END), 0) AS sent, COALESCE(SUM(CASE WHEN paid_at IS NULL AND earned_gd > 0 THEN 1 ELSE 0 END), 0) AS runs_waiting FROM streak_runs WHERE event_id = ?`, [cfg.eventId])
  const answers = await one(`SELECT COUNT(*) AS answered, COALESCE(SUM(a.correct), 0) AS correct FROM streak_answers a JOIN streak_runs r ON r.id = a.run_id WHERE r.event_id = ? AND a.answered_at IS NOT NULL`, [cfg.eventId])
  const campuses = (await run(`SELECT COALESCE(campus, 'Not chosen') AS campus, COUNT(*) AS players, COALESCE(SUM(best_score), 0) AS score FROM streak_players WHERE event_id = ? GROUP BY campus ORDER BY players DESC`, [cfg.eventId])).rows
  const top = (await run(`SELECT p.root_address, u.name, p.campus, p.best_score, p.best_streak, p.runs,
      (SELECT COALESCE(SUM(earned_gd), 0) FROM streak_runs r WHERE r.event_id = p.event_id AND r.root_address = p.root_address) AS earned_gd
    FROM streak_players p JOIN users u ON u.id = p.user_id WHERE p.event_id = ? ORDER BY p.best_score DESC, p.best_at ASC LIMIT 100`, [cfg.eventId])).rows
  const prizes = (await run('SELECT rank, root_address, user_id, score, amount_gd, tx_hash, paid_at AS claimed_at FROM streak_prizes WHERE event_id = ? ORDER BY rank', [cfg.eventId])).rows
  const wallet = await (async () => { const address = streakWalletAddress(); return { address, gd: Number(await gdBalance(address)) / 1e18 } })().catch(() => null)
  return {
    eventId: cfg.eventId, phase: streakPhase(cfg), problem: cfg.problem, wallet,
    prizePool: { totalGd: cfg.prizePoolGd, byPlaceGd: prizesGd(cfg), winners: cfg.winners },
    players: { joined: Number(players.joined), played: Number(players.played), runs: Number(players.runs), longestStreak: Number(players.longest) },
    answers: { answered: Number(answers.answered), correct: Number(answers.correct) },
    answerGd: { perCorrect: cfg.perCorrectGd, poolCap: cfg.poolCapGd, dailyCap: cfg.dailyCapGd, earned: Number(gd.earned), sent: Number(gd.sent), runsWaiting: Number(gd.runs_waiting), poolLeft: Math.max(0, cfg.poolCapGd - Number(gd.earned)) },
    campuses: campuses.map((c) => ({ campus: String(c.campus), players: Number(c.players), score: Number(c.score) })),
    top: top.map((t) => ({ wallet: String(t.root_address), name: t.name, campus: t.campus, bestScore: Number(t.best_score), bestStreak: Number(t.best_streak), runs: Number(t.runs), earnedGd: Number(t.earned_gd) })),
    prizes,
  }
}

/** Public numbers for the stats endpoint. */
export async function streakStats() {
  const cfg = streakConfig()
  const r = (await run('SELECT COUNT(*) AS players, COALESCE(SUM(runs), 0) AS runs, COALESCE(MAX(best_streak), 0) AS longest FROM streak_players WHERE event_id = ?', [cfg.eventId])).rows[0]
  return { eventId: cfg.eventId, players: Number(r.players), runs: Number(r.runs), longestStreak: Number(r.longest) }
}
