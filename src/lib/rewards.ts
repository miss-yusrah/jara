import { parseEther, type Address } from 'viem'
import { sendGdFromTreasury, whitelistedRoot } from './chain'
import { atomic, run } from './db'
import { serverConfig } from './env'
import { syncJars, withUserLock } from './jars'
import { authorizedUser } from './wallet-authorization'
import { type User } from './users'
import { rewardDestination } from './claimers'
import { milestoneConfig, payReferralMilestones } from './referral-payout'
import { getUserById } from './users'

// G$ rewards the agent finds and collects for the user. Each reward is keyed so
// it pays once (or once per period). Paid from the Jara treasury.

interface RewardRule {
  key: (user: User) => string
  title: string
  amountGd: number
  eligible: (user: User) => Promise<boolean>
}

function isoWeek(d = new Date()): string {
  const t = new Date(Date.UTC(d.getFullYear(), d.getMonth(), d.getDate()))
  const day = t.getUTCDay() || 7
  t.setUTCDate(t.getUTCDate() + 4 - day)
  const start = new Date(Date.UTC(t.getUTCFullYear(), 0, 1))
  return `${t.getUTCFullYear()}-W${Math.ceil(((t.getTime() - start.getTime()) / 86_400_000 + 1) / 7)}`
}

async function count(sql: string, args: (string | number)[]) {
  const r = await run(sql, args)
  return Number(r.rows[0]?.n ?? 0)
}

const WEEK = 7 * 86_400_000

/** Every reward pays the same: G$ 100. */
export const REWARD_GD = 100

export const REWARD_RULES: RewardRule[] = [
  {
    key: () => 'first-bill',
    title: 'First bill paid with G$',
    amountGd: REWARD_GD,
    eligible: async (u) => (await count(`SELECT COUNT(*) AS n FROM activity WHERE user_id = ? AND type = 'pay' AND status = 'done'`, [u.id])) > 0,
  },
  {
    key: () => `weekly-saver-${isoWeek()}`,
    title: 'Weekly saver — claimed 5 days this week',
    amountGd: REWARD_GD,
    eligible: async (u) => (await count(`SELECT COUNT(*) AS n FROM activity WHERE user_id = ? AND type = 'claim' AND created_at > ?`, [u.id, Date.now() - WEEK])) >= 5,
  },
  {
    key: () => 'first-ai',
    title: 'First AI helper paid with G$',
    amountGd: REWARD_GD,
    eligible: async (u) => (await count(`SELECT COUNT(*) AS n FROM ai_runs WHERE user_id = ? AND demo = 0`, [u.id])) > 0,
  },
]

export const REFERRAL_REWARD_GD = REWARD_GD
const referralKey = (root: string) => `referral-id-${root}`

/** The account's agent wallet must resolve, on-chain and right now, to the identity it claims. */
async function identityIsVerified(agentAddress: string, root: string): Promise<boolean> {
  if (serverConfig().chain.mode === 'mock') return true
  try {
    return (await whitelistedRoot(agentAddress as Address))?.toLowerCase() === root
  } catch (err) {
    console.warn('[rewards] identity check failed, will retry', err instanceof Error ? err.message : err)
    return false
  }
}

/**
 * Referral: the referrer earns once per verified GoodDollar identity they bring in,
 * never once per Jara account. `referral_identities` holds one row per identity for
 * the whole app, so several accounts linked to the same person (or the same person
 * arriving through several referral links) pay out a single time.
 */
async function referralRewards(user: User, paid: Set<string>): Promise<{ key: string; title: string; amountGd: number }[]> {
  const mine = user.rootAddress?.toLowerCase()
  const referred = (await run(
    `SELECT id, name, root_address, CASE WHEN claimer_active = 1 THEN claimer_address ELSE agent_address END AS agent_address FROM users
     WHERE referred_by = ? AND connected = 1 AND root_address IS NOT NULL ORDER BY created_at, id`,
    [user.id],
  )).rows
  const due: { key: string; title: string; amountGd: number }[] = []
  const seen = new Set<string>()
  for (const x of referred) {
    const root = String(x.root_address).toLowerCase()
    // Your own identity never counts, and neither does a second account of the same person.
    if (root === mine || seen.has(root)) continue
    seen.add(root)
    const key = referralKey(root)
    if (paid.has(key)) continue
    const counted = (await run('SELECT referrer_id, referred_user_id FROM referral_identities WHERE root_address = ?', [root])).rows[0]
    if (counted) {
      // Already counted: for another referrer, or for this one under the older per-account key.
      if (counted.referrer_id !== user.id || paid.has(`referral-${counted.referred_user_id}`)) continue
    } else {
      if (!(await identityIsVerified(String(x.agent_address), root))) continue
      const claimed = await run('INSERT OR IGNORE INTO referral_identities (root_address, referrer_id, referred_user_id, created_at) VALUES (?, ?, ?, ?)', [root, user.id, String(x.id), Date.now()])
      if (!claimed.rowsAffected) continue // another referrer counted this identity first
    }
    due.push({ key, title: `${(x.name as string) || 'A friend'} joined with your link`, amountGd: REFERRAL_REWARD_GD })
  }
  return due
}

/** Reserve before signing. Unknown outcomes retain their budget across retries and restarts. */
export async function reserveReferralBudget(id: string, amountGd: number): Promise<boolean> {
  const { referralBudgetGd, referralDailyGd } = serverConfig().rewards
  if (![amountGd, referralBudgetGd, referralDailyGd].every(n => Number.isSafeInteger(n) && n >= 0) || amountGd === 0) throw new Error('Invalid referral budget')
  const now = Date.now()
  const dayStart = Math.floor(now / 86_400_000) * 86_400_000
  return atomic(async tx => {
    const prior = (await tx.execute({ sql: 'SELECT amount_gd FROM referral_budget WHERE id = ?', args: [id] })).rows[0]
    if (prior) {
      if (Number(prior.amount_gd) !== amountGd) throw new Error('Referral reservation amount changed')
      return true
    }
    const totals = (await tx.execute({ sql: 'SELECT COALESCE(SUM(amount_gd),0) AS total, COALESCE(SUM(CASE WHEN created_at >= ? THEN amount_gd ELSE 0 END),0) AS today FROM referral_budget', args: [dayStart] })).rows[0]
    if (Number(totals.total) + amountGd > referralBudgetGd || Number(totals.today) + amountGd > referralDailyGd) return false
    await tx.execute({ sql: 'INSERT INTO referral_budget(id, amount_gd, created_at) VALUES (?, ?, ?)', args: [id, amountGd, now] })
    return true
  })
}

export async function referralBudgetStatus() {
  const dayStart = Math.floor(Date.now() / 86_400_000) * 86_400_000
  const totals = (await run('SELECT COALESCE(SUM(amount_gd),0) AS reservedGd, COALESCE(SUM(CASE WHEN created_at >= ? THEN amount_gd ELSE 0 END),0) AS todayGd FROM referral_budget', [dayStart])).rows[0]
  return { ...totals, limitGd: serverConfig().rewards.referralBudgetGd, dailyLimitGd: serverConfig().rewards.referralDailyGd }
}

async function alreadyPaid(userId: string): Promise<Set<string>> {
  const r = await run('SELECT reward_key FROM rewards_paid WHERE user_id = ?', [userId])
  return new Set(r.rows.map((x) => x.reward_key as string))
}

/** Referral rewards are paid from the one Jara treasury. */
async function sendReferralReward(to: Address, amount: bigint, id: string) {
  return sendGdFromTreasury(to, amount, id)
}

/** Find and collect every reward the user qualifies for. */
export async function collectRewards(user: User): Promise<{ title: string; amountGd: number }[]> {
  return withUserLock(user.id, async () => {
    user = await authorizedUser(user)
    const paid = await alreadyPaid(user.id)
    const due: { key: string; title: string; amountGd: number }[] = []
    for (const rule of REWARD_RULES) {
      const key = rule.key(user)
      if (!paid.has(key) && (await rule.eligible(user))) due.push({ key, title: rule.title, amountGd: rule.amountGd })
    }
    due.push(...(await referralRewards(user, paid)))

    const collected: { title: string; amountGd: number }[] = []
    for (const r of due) {
      try {
        const amount = parseEther(String(r.amountGd))
        const id = `reward:${user.id}:${r.key}`
        if (r.key.startsWith('referral-') && !(await reserveReferralBudget(id, r.amountGd))) continue
        const destination = await rewardDestination(user, id)
        const hash = r.key.startsWith('referral-') ? await sendReferralReward(destination, amount, id) : await sendGdFromTreasury(destination, amount, id)
        await atomic(async (tx) => {
          await tx.execute({ sql: 'INSERT OR IGNORE INTO rewards_paid(user_id, reward_key, amount_gd, created_at) VALUES (?, ?, ?, ?)', args: [user.id, r.key, r.amountGd, Date.now()] })
          await tx.execute({ sql: `INSERT OR IGNORE INTO activity(user_id, type, amount_wei, tx_hash, title, operation_id, created_at) VALUES (?, 'reward', ?, ?, ?, ?, ?)`, args: [user.id, String(amount), hash, `Reward found: ${r.title}`, `reward:${user.id}:${r.key}`, Date.now()] })
        })
        collected.push(r)
      } catch (err) {
        console.error('[rewards] payout failed', r.key, err)
      }
    }
    // Every 10 verified friends: G$ worth ₦5,000 straight to their own wallet.
    for (const m of await payReferralMilestones(user).catch((err) => { console.error('[rewards] milestone payout deferred', err instanceof Error ? err.message : 'error'); return [] })) {
      collected.push({ title: `${m.friends} friends invited`, amountGd: m.amountGd })
    }
    if (collected.length) await syncJars(user)
    return collected
  })
}

export type Referral = { name: string; joinedAt: number; status: 'joined' | 'verified' | 'rewarded' }

/**
 * Who joined with this person's invite link, newest first. Names only, never wallets.
 * joined: has an account, not set up yet. verified: set up with a verified GoodDollar
 * identity, reward on its way (Jara collects it on the next hourly run, budget allowing).
 * rewarded: the G$ 100 reward was paid.
 */
export async function listReferrals(user: User): Promise<Referral[]> {
  const rows = (await run(
    `SELECT id, name, created_at, connected, root_address FROM users WHERE referred_by = ? ORDER BY created_at DESC, id LIMIT 100`,
    [user.id],
  )).rows
  if (!rows.length) return []
  const paid = await alreadyPaid(user.id)
  return rows.map((x) => {
    const root = x.root_address ? String(x.root_address).toLowerCase() : null
    const rewarded = Boolean(root && paid.has(referralKey(root))) || paid.has(`referral-${String(x.id)}`)
    const status: Referral['status'] = rewarded ? 'rewarded' : Number(x.connected) === 1 && root ? 'verified' : 'joined'
    return { name: (x.name as string | null)?.trim() || 'A friend', joinedAt: Number(x.created_at), status }
  })
}

/** What the user is close to earning, for the dashboard. */
export async function rewardProgress(user: User) {
  const paid = await alreadyPaid(user.id)
  const claimsThisWeek = await count(`SELECT COUNT(*) AS n FROM activity WHERE user_id = ? AND type = 'claim' AND created_at > ?`, [user.id, Date.now() - WEEK])
  const earned = await run('SELECT COALESCE(SUM(amount_gd), 0) AS n FROM rewards_paid WHERE user_id = ?', [user.id])
  return {
    earnedGd: Number(earned.rows[0].n),
    items: [
      { title: 'Weekly saver', detail: `${Math.min(claimsThisWeek, 5)}/5 claim days`, amountGd: REWARD_GD, done: paid.has(`weekly-saver-${isoWeek()}`), progress: Math.min(claimsThisWeek, 5) / 5 },
      { title: 'First bill with G$', detail: 'Pay any bill', amountGd: REWARD_GD, done: paid.has('first-bill'), progress: paid.has('first-bill') ? 1 : 0 },
      { title: 'First AI helper', detail: 'Use any AI helper', amountGd: REWARD_GD, done: paid.has('first-ai'), progress: paid.has('first-ai') ? 1 : 0 },
      { title: 'Invite a friend', detail: 'Per verified friend, within the referral campaign budget', amountGd: REFERRAL_REWARD_GD, done: false, progress: 0 },
    ],
  }
}

const lastSweep = new Map<string, number>()

/**
 * The per-minute check for referral milestones, so a reward arrives within minutes of the friend
 * who completes a set of 10 getting verified, not at the next daily run. It looks only at people
 * whose connected friends could complete a set they have not been paid for, and checks each at most
 * every 10 minutes (counting a friend means checking their identity on-chain).
 */
export async function payDueReferralMilestones(): Promise<number> {
  const cfg = milestoneConfig()
  if (!cfg.enabled) return 0
  const due = (await run(`SELECT c.referrer_id AS user_id FROM
      (SELECT referred_by AS referrer_id, COUNT(DISTINCT lower(root_address)) AS n FROM users WHERE referred_by IS NOT NULL AND connected = 1 AND root_address IS NOT NULL GROUP BY referred_by) c
    LEFT JOIN (SELECT user_id, COUNT(*) AS done FROM referral_payouts WHERE status IN ('paid', 'manual') GROUP BY user_id) p ON p.user_id = c.referrer_id
    WHERE c.n / ? > COALESCE(p.done, 0) LIMIT 200`, [cfg.friends])).rows
  let sent = 0
  for (const row of due) {
    const id = String(row.user_id)
    if (Date.now() - (lastSweep.get(id) ?? 0) < 10 * 60_000) continue
    lastSweep.set(id, Date.now())
    const account = await getUserById(id)
    if (!account?.connected || !account.rootAddress) continue
    try {
      sent += (await collectRewards(account)).length
    } catch (err) {
      console.warn('[rewards] milestone check deferred', id, err instanceof Error ? err.message : 'error')
    }
  }
  return sent
}
