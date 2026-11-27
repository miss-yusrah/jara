import { parseEther, type Address } from 'viem'
import * as chain from './chain'
import { TransferPendingError, TransferRevertedError } from './chain-outbox'
import { atomic, run } from './db'
import { serverConfig } from './env'
import { ngnPerGd } from './price'
import { type User } from './users'

// Referral milestones, paid automatically.
//
// Every REFERRAL_MILESTONE_FRIENDS verified friends (10 by default: 10, 20, 30…) earns G$ worth
// REFERRAL_MILESTONE_NGN naira (₦5,000) at the G$ price of the moment it is earned. Jara sends it
// from the treasury straight to the person's own verified GoodDollar wallet. Nobody does anything by
// hand. They can then spend it in Jara or cash it out to naira with GoodCash.
//
// Friends are counted from referral_identities: one row per verified GoodDollar identity, app wide,
// so extra accounts of the same person never count twice.
//
// Never twice: one row per milestone, with its G$ amount and wallet fixed when the row is created,
// and the transfer is durable under `referral-milestone:<account>:<milestone>` (a retry replays the
// same signed transaction). Rows marked 'manual' were paid before this existed (referralStartingLine).

type Status = 'sending' | 'paid' | 'manual'

interface PayoutRow {
  user_id: string
  milestone: number
  status: Status
  amount_ngn: number
  amount_g: string | null
  to_address: string | null
  tx_hash: string | null
  error: string | null
  updated_at: number
}

export function milestoneConfig() {
  const { friends, ngn } = serverConfig().referralMilestone
  return { friends: Math.max(1, Math.floor(friends)), ngn: Math.max(0, Math.floor(ngn)), enabled: ngn > 0 && chain.referralWalletConfigured() }
}

/** The G$ worth `ngn` naira at today's price, rounded to the nearest G$ 100. */
async function rewardGdFor(ngn: number): Promise<number> {
  const rate = await ngnPerGd()
  if (!(rate > 0)) throw new Error('no G$ price')
  return Math.max(100, Math.round(ngn / rate / 100) * 100)
}

const opId = (userId: string, milestone: number) => `referral-milestone:${userId}:${milestone}`

async function verifiedFriends(userId: string): Promise<number> {
  return Number((await run('SELECT COUNT(*) AS n FROM referral_identities WHERE referrer_id = ?', [userId])).rows[0].n)
}

async function rows(userId: string): Promise<PayoutRow[]> {
  return (await run('SELECT * FROM referral_payouts WHERE user_id = ? ORDER BY milestone', [userId])).rows as unknown as PayoutRow[]
}

/** What the Rewards screen shows. Reads only (plus today's G$ price). */
export async function referralRewardState(user: User) {
  const cfg = milestoneConfig()
  const friends = await verifiedFriends(user.id)
  const list = await rows(user.id)
  const view = (r: PayoutRow) => ({
    milestone: Number(r.milestone),
    friends: Number(r.milestone) * cfg.friends,
    amountGd: r.amount_g == null ? null : Number(r.amount_g),
    amountNgn: Number(r.amount_ngn),
    at: Number(r.updated_at),
  })
  return {
    enabled: cfg.enabled,
    friendsPerReward: cfg.friends,
    /** The naira value of each reward; it is paid in G$. */
    rewardNgn: cfg.ngn,
    /** Today's G$ for the next reward (null if the price is unavailable). */
    rewardGd: cfg.enabled ? await rewardGdFor(cfg.ngn).catch(() => null) : null,
    verifiedFriends: friends,
    /** Friends counted toward the next reward. */
    towardNext: friends % cfg.friends,
    /** Rewards on their way to the wallet right now. */
    sending: list.filter((r) => r.status === 'sending').map(view),
    /** Rewards Jara sent to the wallet, oldest first. */
    sent: list.filter((r) => r.status === 'paid').map(view),
    /** Earlier rewards, paid before this existed. */
    earlier: list.filter((r) => r.status === 'manual').length,
    /** When this was read, so the screen can tell whether the latest reward is still news. */
    now: Date.now(),
  }
}
export type ReferralRewardState = Awaited<ReturnType<typeof referralRewardState>>

/**
 * Send every milestone this person has reached and not yet been paid for. Call with the account lock
 * held and an authorized (verified) user. Returns the rewards sent now.
 */
export async function payReferralMilestones(user: User): Promise<{ friends: number; amountGd: number }[]> {
  const cfg = milestoneConfig()
  if (!cfg.enabled || !user.rootAddress) return []
  const earned = Math.floor((await verifiedFriends(user.id)) / cfg.friends)
  const have = new Map((await rows(user.id)).map((r) => [Number(r.milestone), r]))
  const paid: { friends: number; amountGd: number }[] = []
  for (let m = 1; m <= earned; m++) {
    let r = have.get(m)
    if (r?.status === 'paid' || r?.status === 'manual') continue
    if (!r) {
      let amountGd: number
      try { amountGd = await rewardGdFor(cfg.ngn) } catch { console.warn('[referral] no G$ price, will retry'); break }
      const now = Date.now()
      // Fixed here: every retry sends exactly this amount to exactly this wallet.
      await run(`INSERT OR IGNORE INTO referral_payouts (user_id, milestone, status, amount_ngn, amount_g, to_address, created_at, updated_at) VALUES (?, ?, 'sending', ?, ?, ?, ?, ?)`,
        [user.id, m, cfg.ngn, String(amountGd), user.rootAddress.toLowerCase(), now, now])
      r = (await run('SELECT * FROM referral_payouts WHERE user_id = ? AND milestone = ?', [user.id, m])).rows[0] as unknown as PayoutRow
      if (r.status !== 'sending') continue
    }
    const id = opId(user.id, m)
    const amount = parseEther(String(r.amount_g))
    let hash: string
    try {
      hash = await chain.sendGdFromReferralWallet(r.to_address as Address, amount, id)
    } catch (err) {
      // Pending: the same signed transaction is settled on the next run. Anything else (for example
      // the referral wallet is out of G$ or CELO): nothing was sent; try again on the next run.
      const why = err instanceof TransferPendingError ? 'Waiting for the network to confirm.'
        : err instanceof TransferRevertedError ? 'The transfer did not go through. Retrying.'
        : 'The referral wallet could not send yet (check its G$ and CELO). Retrying.'
      if (!(err instanceof TransferPendingError)) console.error('[referral] milestone payout deferred', id, err instanceof Error ? err.message : 'error')
      await run('UPDATE referral_payouts SET error = ?, updated_at = ? WHERE user_id = ? AND milestone = ?', [why, Date.now(), user.id, m])
      break
    }
    const gd = Number(r.amount_g)
    const ngn = Number(r.amount_ngn)
    await atomic(async (tx) => {
      const done = await tx.execute({ sql: "UPDATE referral_payouts SET status = 'paid', tx_hash = ?, error = NULL, updated_at = ? WHERE user_id = ? AND milestone = ? AND status = 'sending'", args: [hash, Date.now(), user.id, m] })
      if (!done.rowsAffected) return
      await tx.execute({ sql: 'INSERT OR IGNORE INTO rewards_paid (user_id, reward_key, amount_gd, created_at) VALUES (?, ?, ?, ?)', args: [user.id, `milestone-referral-${m}`, gd, Date.now()] })
      await tx.execute({
        sql: "INSERT OR IGNORE INTO activity (user_id, type, amount_wei, tx_hash, title, operation_id, created_at) VALUES (?, 'reward', ?, ?, ?, ?, ?)",
        args: [user.id, String(amount), hash, `🎉 ${m * cfg.friends} friends invited: G$ ${gd.toLocaleString('en-US')} (≈ ₦${ngn.toLocaleString('en-NG')}) sent to your wallet`, id, Date.now()],
      })
    })
    paid.push({ friends: m * cfg.friends, amountGd: gd })
  }
  return paid
}

/** Admin: the referral wallet's balance and every milestone payout, newest first. */
export async function referralPayoutReport() {
  const payouts = (await run(`SELECT p.user_id, u.name, p.to_address, p.milestone, p.status, p.amount_ngn, p.amount_g, p.tx_hash, p.error, p.updated_at
    FROM referral_payouts p JOIN users u ON u.id = p.user_id WHERE p.status != 'manual' ORDER BY p.updated_at DESC LIMIT 200`)).rows
  const totals = (await run("SELECT COALESCE(SUM(CAST(amount_g AS REAL)), 0) AS gd, COUNT(*) AS n FROM referral_payouts WHERE status = 'paid'")).rows[0]
  return { wallet: await chain.referralWalletBalances().catch(() => null), paidGd: Number(totals.gd), paidCount: Number(totals.n), payouts }
}
