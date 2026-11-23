import { randomBytes } from 'node:crypto'
import { isAddress, keccak256, concat, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { atomic, run } from './db'
import { serverConfig } from './env'
import { GD, whitelistedRoot } from './chain'
import type { User } from './users'
import { NETWORKS } from './catalog'
import { dailyQuestions } from './daily-challenge-questions'
import { challengeClient } from './daily-challenge-chain'
import {
  challengeAbi,
  challengeDay,
  challengeId,
  completionHash,
  dayClosesAt,
  dayLabel,
  type ChallengeView,
} from './daily-challenge-shared'

export class ChallengeError extends Error {
  constructor(
    message: string,
    readonly status = 400,
  ) {
    super(message)
  }
}

export function challengeConfig() {
  const raw = process.env.DAILY_CHALLENGE_CONTRACT
  const address = raw && isAddress(raw) ? (raw.toLowerCase() as Address) : null
  // Demo users never obtain signatures for the real prize contract.
  const live = serverConfig().chain.mode === 'celo'
  return {
    address: live ? address : null,
    enabled: live && process.env.DAILY_CHALLENGE_ENABLED === 'true',
    key: process.env.DAILY_CHALLENGE_SIGNER_KEY as Hex | undefined,
  }
}

function rootOf(user: User): Address {
  if (!user.connected || !user.rootAddress || !isAddress(user.rootAddress))
    throw new ChallengeError('Connect your verified GoodDollar wallet first.', 403)
  return user.rootAddress.toLowerCase() as Address
}

export async function campaign() {
  const cfg = challengeConfig()
  if (!cfg.address) return null
  const pub = challengeClient()
  const read = <T extends 'startDay' | 'endDay' | 'paused' | 'completionSigner' | 'identity'>(functionName: T) =>
    pub.readContract({ address: cfg.address!, abi: challengeAbi, functionName })
  const [start, end, paused, signer, identity] = await Promise.all([
    read('startDay'),
    read('endDay'),
    read('paused'),
    read('completionSigner'),
    read('identity'),
  ])
  if (String(identity).toLowerCase() !== GD.identity.toLowerCase())
    throw new ChallengeError('The challenge campaign configuration needs attention.', 503)
  return {
    ...cfg,
    address: cfg.address,
    start: Number(start),
    end: Number(end),
    paused: Boolean(paused),
    signer: String(signer),
  }
}

async function openCampaign(day: number) {
  if (!Number.isSafeInteger(day) || day !== challengeDay())
    throw new ChallengeError('A new day has started. Reload for today’s challenge.', 409)
  const c = await campaign()
  if (!c || !c.enabled || c.paused || day < c.start || day > c.end)
    throw new ChallengeError('Entries are not open right now.', 409)
  return c
}

async function attempt(contract: string, root: string, day: number) {
  return (
    await run('SELECT answers, reviewed_at FROM daily_challenge_attempts WHERE contract = ? AND root = ? AND day = ?', [
      contract,
      root,
      day,
    ])
  ).rows[0]
}

export async function submitChallenge(user: User, day: number, answers: unknown) {
  const root = rootOf(user)
  const c = await openCampaign(day)
  const questions = dailyQuestions(day).questions
  if (
    !Array.isArray(answers) ||
    answers.length !== questions.length ||
    answers.some((answer, i) => !Number.isInteger(answer) || answer < 0 || answer >= questions[i].options.length)
  ) {
    throw new ChallengeError('Answer all three questions before reviewing.')
  }
  // All answers qualify; retrying cannot alter the saved submission or create another entry.
  await run(
    'INSERT OR IGNORE INTO daily_challenge_attempts(contract, root, day, answers, created_at) VALUES (?, ?, ?, ?, ?)',
    [c.address, root, day, JSON.stringify(answers), Date.now()],
  )
  const saved = await attempt(c.address, root, day)
  const selected = JSON.parse(String(saved.answers)) as number[]
  return {
    review: questions.map((q, i) => ({
      correctOption: q.correctOption,
      explanation: q.explanation,
      selected: selected[i],
    })),
  }
}

export async function prepareChallengeEntry(user: User, day: number) {
  const root = rootOf(user)
  const c = await openCampaign(day)
  if (!(await attempt(c.address, root, day)))
    throw new ChallengeError('Complete today’s questions and review the explanations first.')
  if ((await whitelistedRoot(root))?.toLowerCase() !== root)
    throw new ChallengeError('Your wallet needs current GoodDollar face verification.', 403)
  if (!c.key || !/^0x[0-9a-fA-F]{64}$/.test(c.key))
    throw new ChallengeError('Entries are temporarily unavailable. Please try again later.', 503)
  const signer = privateKeyToAccount(c.key)
  if (signer.address.toLowerCase() !== c.signer.toLowerCase())
    throw new ChallengeError('Entries are temporarily unavailable. Please try again later.', 503)
  await run(
    'UPDATE daily_challenge_attempts SET reviewed_at = COALESCE(reviewed_at, ?) WHERE contract = ? AND root = ? AND day = ?',
    [Date.now(), c.address, root, day],
  )
  const signature = await signer.signMessage({ message: { raw: completionHash(c.address, root, day) } })
  return { contract: c.address, day, challengeId: challengeId(day), signature }
}

export async function challengeView(user: User): Promise<ChallengeView> {
  const day = challengeDay()
  const root = user.rootAddress?.toLowerCase() as Address | undefined
  const c = await campaign()
  const set = dailyQuestions(day)
  const base: ChallengeView = {
    available: false,
    reason: 'Daily Jara is getting ready. Entries and prizes are not live yet.',
    contract: c?.address ?? null,
    day,
    date: dayLabel(day),
    closesAt: dayClosesAt(day),
    title: set.title,
    questions: set.questions.map(({ prompt, options }) => ({ prompt, options })),
    review: null,
    entered: false,
    streak: 0,
    week: [],
    entryCount: 0,
    results: [],
    prizes: [],
  }
  if (!c) return base
  base.available = c.enabled && !c.paused && day >= c.start && day <= c.end
  base.reason = base.available
    ? null
    : day < c.start
      ? `The next campaign starts ${dayLabel(c.start)} at midnight Lagos time.`
      : day > c.end
        ? 'This campaign has ended. Your past entries and prizes are still available below.'
        : 'New entries are paused. Existing entries and prizes are preserved.'
  const pub = challengeClient()
  const count = await pub.readContract({
    address: c.address,
    abi: challengeAbi,
    functionName: 'entryCount',
    args: [BigInt(day)],
  })
  base.entryCount = Number(count)
  if (root && isAddress(root)) {
    // Week starts on Monday in Lagos, never a browser-dependent timezone.
    const weekStart = day - ((new Date(day * 86_400_000).getUTCDay() + 6) % 7)
    const [saved, progress, days, prizes] = await Promise.all([
      attempt(c.address, root, day),
      pub.readContract({ address: c.address, abi: challengeAbi, functionName: 'progress', args: [root] }),
      Promise.all(
        Array.from({ length: 7 }, (_, i) =>
          pub.readContract({
            address: c.address,
            abi: challengeAbi,
            functionName: 'entered',
            args: [BigInt(weekStart + i), root],
          }),
        ),
      ),
      run(
        'SELECT day, phone, network, delivered_at FROM daily_challenge_winners WHERE contract = ? AND root = ? ORDER BY day DESC',
        [c.address, root],
      ),
    ])
    base.week = days.map((entered, i) => ({
      label: ['M', 'T', 'W', 'T', 'F', 'S', 'S'][i],
      entered,
      today: weekStart + i === day,
    }))
    base.entered = days[day - weekStart]
    base.streak = Number(progress[0]) >= day - 1 ? Number(progress[1]) : 0
    if (saved) {
      const answers = JSON.parse(String(saved.answers)) as number[]
      base.review = set.questions.map((q, i) => ({
        correctOption: q.correctOption,
        explanation: q.explanation,
        selected: answers[i],
      }))
    }
    base.prizes = prizes.rows.map((p) => ({
      day: Number(p.day),
      date: dayLabel(Number(p.day)),
      delivered: p.delivered_at !== null,
      phone: p.phone as string | null,
      network: p.network as string | null,
    }))
  }
  const draws = await run(
    'SELECT day, participants FROM daily_challenge_draws WHERE contract = ? ORDER BY day DESC LIMIT 7',
    [c.address],
  )
  base.results = await Promise.all(
    draws.rows.map(async (draw) => {
      const winners = await run(
        'SELECT root, delivered_at FROM daily_challenge_winners WHERE contract = ? AND day = ? ORDER BY rank',
        [c.address, draw.day],
      )
      return {
        day: Number(draw.day),
        date: dayLabel(Number(draw.day)),
        entrants: (JSON.parse(String(draw.participants)) as string[]).length,
        winners: winners.rows.map((w) => ({ wallet: String(w.root), delivered: w.delivered_at !== null })),
      }
    }),
  )
  return base
}

// Deterministic ordering for an auditable server-run draw. The operator supplies the
// randomness; this is explicitly NOT VRF or a trustless on-chain random draw.
export function selectWinners(participants: Address[], seed: Hex): Address[] {
  return participants
    .map((wallet) => ({ wallet, score: keccak256(concat([seed, wallet])) }))
    .sort((a, b) => (a.score < b.score ? -1 : a.score > b.score ? 1 : a.wallet.localeCompare(b.wallet)))
    .slice(0, 5)
    .map(({ wallet }) => wallet)
}

export async function drawChallenge(day: number) {
  const c = await campaign()
  if (!c || !Number.isSafeInteger(day) || day < c.start || day > c.end || day >= challengeDay())
    throw new ChallengeError('Choose a closed day within this campaign.')
  const existing = (await run('SELECT day FROM daily_challenge_draws WHERE contract = ? AND day = ?', [c.address, day]))
    .rows[0]
  if (existing) return { day, existing: true }
  const pub = challengeClient()
  // Snapshot only a finalized block after close. Include even entries never synced to our DB.
  const block = await pub.getBlock({ blockTag: 'finalized' })
  if (Number(block.timestamp) * 1000 < dayClosesAt(day) || block.number === null || !block.hash)
    throw new ChallengeError('Waiting for the closing block to finalize. Try again shortly.', 409)
  const total = Number(
    await pub.readContract({
      address: c.address,
      abi: challengeAbi,
      functionName: 'entryCount',
      args: [BigInt(day)],
      blockNumber: block.number,
    }),
  )
  const participants: Address[] = []
  for (let i = 0; i < total; i += 25) {
    participants.push(
      ...(await Promise.all(
        Array.from({ length: Math.min(25, total - i) }, (_, j) =>
          pub.readContract({
            address: c.address,
            abi: challengeAbi,
            functionName: 'participantAt',
            args: [BigInt(day), BigInt(i + j)],
            blockNumber: block.number,
          }),
        ),
      )),
    )
  }
  return atomic(async (tx) => {
    if (
      (
        await tx.execute({
          sql: 'SELECT day FROM daily_challenge_draws WHERE contract = ? AND day = ?',
          args: [c.address, day],
        })
      ).rows.length
    )
      return { day, existing: true }
    const seed = `0x${randomBytes(32).toString('hex')}` as Hex
    await tx.execute({
      sql: 'INSERT INTO daily_challenge_draws(contract, day, seed, participants, block_number, block_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
      args: [c.address, day, seed, JSON.stringify(participants), String(block.number), block.hash, Date.now()],
    })
    const winners = selectWinners(participants, seed)
    for (const [rank, wallet] of winners.entries())
      await tx.execute({
        sql: 'INSERT INTO daily_challenge_winners(contract, day, root, rank) VALUES (?, ?, ?, ?)',
        args: [c.address, day, wallet.toLowerCase(), rank + 1],
      })
    return { day, existing: false, winners }
  })
}

export async function savePrizePhone(user: User, day: number, phone: unknown, network: unknown) {
  const root = rootOf(user)
  const { address } = challengeConfig()
  if (
    !address ||
    !Number.isSafeInteger(day) ||
    typeof phone !== 'string' ||
    !/^0[789]\d{9}$/.test(phone) ||
    !NETWORKS.includes(network as (typeof NETWORKS)[number])
  )
    throw new ChallengeError('Enter an 11-digit Nigerian phone number and choose its network.')
  // Recipient is locked once submitted, so an operator cannot deliver to stale details.
  const updated = await run(
    'UPDATE daily_challenge_winners SET phone = ?, network = ?, recipient_at = ? WHERE contract = ? AND day = ? AND root = ? AND phone IS NULL AND delivered_at IS NULL',
    [phone, String(network), Date.now(), address, day, root],
  )
  if (!updated.rowsAffected) {
    const saved = (
      await run('SELECT phone, network FROM daily_challenge_winners WHERE contract = ? AND day = ? AND root = ?', [
        address,
        day,
        root,
      ])
    ).rows[0]
    if (!saved || saved.phone !== phone || saved.network !== network)
      throw new ChallengeError('No unclaimed prize was found, or its recipient is already saved.', 409)
  }
}

export async function recordPrizeDelivery(day: number, root: unknown, reference: unknown) {
  const { address } = challengeConfig()
  if (
    !address ||
    !Number.isSafeInteger(day) ||
    typeof root !== 'string' ||
    !isAddress(root) ||
    typeof reference !== 'string' ||
    reference.trim().length < 3 ||
    reference.length > 160
  )
    throw new ChallengeError('Select a winner and provide the successful provider receipt/reference.')
  const result = await run(
    'UPDATE daily_challenge_winners SET delivery_ref = ?, delivered_at = ? WHERE contract = ? AND day = ? AND root = ? AND phone IS NOT NULL AND delivered_at IS NULL',
    [reference.trim(), Date.now(), address, day, root.toLowerCase()],
  )
  if (!result.rowsAffected) {
    const saved = (
      await run('SELECT delivery_ref FROM daily_challenge_winners WHERE contract = ? AND day = ? AND root = ?', [
        address,
        day,
        root.toLowerCase(),
      ])
    ).rows[0]
    if (!saved || saved.delivery_ref !== reference.trim())
      throw new ChallengeError(
        'Recipient details are missing, or this prize was already recorded with another receipt.',
        409,
      )
  }
}

export async function challengeAdminReport() {
  const c = await campaign()
  if (!c) return { campaign: null, days: [], winners: [] }
  const [draws, winners] = await Promise.all([
    run('SELECT day, created_at FROM daily_challenge_draws WHERE contract = ?', [c.address]),
    run(
      'SELECT day, root, rank, phone, network, recipient_at, delivery_ref, delivered_at FROM daily_challenge_winners WHERE contract = ? ORDER BY day DESC, rank',
      [c.address],
    ),
  ])
  return {
    campaign: {
      contract: c.address,
      start: dayLabel(c.start),
      end: dayLabel(c.end),
      enabled: c.enabled,
      paused: c.paused,
      budgetNgn: (c.end - c.start + 1) * 5000,
    },
    days: Array.from({ length: c.end - c.start + 1 }, (_, i) => ({
      day: c.start + i,
      date: dayLabel(c.start + i),
      closed: c.start + i < challengeDay(),
      drawn: draws.rows.some((d) => Number(d.day) === c.start + i),
    })),
    winners: winners.rows,
  }
}
