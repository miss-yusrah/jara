import { parseEther } from 'viem'
import { sendGdFromTreasury } from './chain'
import { atomic, run } from './db'
import { syncJars, withUserLock } from './jars'
import { authorizedUser } from './wallet-authorization'
import { type User } from './users'

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

export const REWARD_RULES: RewardRule[] = [
  {
    key: () => 'first-bill',
    title: 'First bill paid with G$',
    amountGd: 300,
    eligible: async (u) => (await count(`SELECT COUNT(*) AS n FROM activity WHERE user_id = ? AND type = 'pay' AND status = 'done'`, [u.id])) > 0,
  },
  {
    key: () => `weekly-saver-${isoWeek()}`,
    title: 'Weekly saver — claimed 5 days this week',
    amountGd: 400,
    eligible: async (u) => (await count(`SELECT COUNT(*) AS n FROM activity WHERE user_id = ? AND type = 'claim' AND created_at > ?`, [u.id, Date.now() - WEEK])) >= 5,
  },
  {
    key: () => 'first-ai',
    title: 'First AI helper paid with G$',
    amountGd: 200,
    eligible: async (u) => (await count(`SELECT COUNT(*) AS n FROM ai_runs WHERE user_id = ? AND demo = 0`, [u.id])) > 0,
  },
]

/** Referral: the referrer earns once each referred friend connects. */
async function referralRewards(user: User): Promise<{ key: string; title: string; amountGd: number }[]> {
  const r = await run(`SELECT id, name FROM users WHERE referred_by = ? AND connected = 1`, [user.id])
  return r.rows.map((x) => ({ key: `referral-${x.id}`, title: `${(x.name as string) || 'A friend'} joined with your link`, amountGd: 1000 }))
}

async function alreadyPaid(userId: string): Promise<Set<string>> {
  const r = await run('SELECT reward_key FROM rewards_paid WHERE user_id = ?', [userId])
  return new Set(r.rows.map((x) => x.reward_key as string))
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
    for (const r of await referralRewards(user)) if (!paid.has(r.key)) due.push(r)

    const collected: { title: string; amountGd: number }[] = []
    for (const r of due) {
      try {
        const amount = parseEther(String(r.amountGd))
        const hash = await sendGdFromTreasury(user.agentAddress, amount, `reward:${user.id}:${r.key}`)
        await atomic(async (tx) => {
          await tx.execute({ sql: 'INSERT OR IGNORE INTO rewards_paid(user_id, reward_key, amount_gd, created_at) VALUES (?, ?, ?, ?)', args: [user.id, r.key, r.amountGd, Date.now()] })
          await tx.execute({ sql: `INSERT OR IGNORE INTO activity(user_id, type, amount_wei, tx_hash, title, operation_id, created_at) VALUES (?, 'reward', ?, ?, ?, ?, ?)`, args: [user.id, String(amount), hash, `Reward found: ${r.title}`, `reward:${user.id}:${r.key}`, Date.now()] })
        })
        collected.push(r)
      } catch (err) {
        console.error('[rewards] payout failed', r.key, err)
      }
    }
    if (collected.length) await syncJars(user)
    return collected
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
      { title: 'Weekly saver', detail: `${Math.min(claimsThisWeek, 5)}/5 claim days`, amountGd: 400, done: paid.has(`weekly-saver-${isoWeek()}`), progress: Math.min(claimsThisWeek, 5) / 5 },
      { title: 'First bill with G$', detail: 'Pay any bill', amountGd: 300, done: paid.has('first-bill'), progress: paid.has('first-bill') ? 1 : 0 },
      { title: 'First AI helper', detail: 'Use any AI helper', amountGd: 200, done: paid.has('first-ai'), progress: paid.has('first-ai') ? 1 : 0 },
      { title: 'Invite a friend', detail: 'Per friend who joins', amountGd: 1000, done: false, progress: 0 },
    ],
  }
}
