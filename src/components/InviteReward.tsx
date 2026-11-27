'use client'

import { Icon } from './Icon'
import { GoodCashCashOut, goodCashConfigured } from './GoodCash'

// Referral milestones on the Rewards tab. Every 10 verified friends, Jara automatically sends G$
// worth ₦5,000 to the person's own wallet; nothing to claim. This shows how many friends they have
// invited, how far they are from the next 10, and, once a reward has landed, what they can do with
// it: cash it out to their bank with GoodCash, or spend it in Jara.

type Paid = { milestone: number; friends: number; amountGd: number | null; amountNgn: number; at: number }
export type InviteRewardState = {
  enabled: boolean
  friendsPerReward: number
  rewardNgn: number
  rewardGd: number | null
  verifiedFriends: number
  towardNext: number
  sending: Paid[]
  sent: Paid[]
  earlier: number
  now: number
}

const ngn = (n: number) => `₦${n.toLocaleString('en-NG')}`
const gd = (n: number) => `G$ ${n.toLocaleString('en-US')}`
/** Celebrate a reward for a week after it lands. */
const FRESH_MS = 7 * 86_400_000

export function InviteReward({ reward, name, userId, wallet, flash, onPay }: {
  reward: InviteRewardState | null | undefined
  name: string | null
  userId: string
  wallet: `0x${string}` | null
  flash: (t: string) => void
  onPay?: () => void
}) {
  if (!reward?.enabled) return null
  const { friendsPerReward: goal, rewardNgn, towardNext, verifiedFriends: invited } = reward
  const nextAt = invited - towardNext + goal
  const prize = reward.rewardGd ? `${gd(reward.rewardGd)} (≈ ${ngn(rewardNgn)})` : `G$ worth ${ngn(rewardNgn)}`
  const latest = reward.sent.at(-1)
  const fresh = latest && reward.now - latest.at < FRESH_MS ? latest : null
  const sending = reward.sending[0]
  const first = name?.split(' ')[0]
  const totalPaid = reward.sent.length + reward.earlier

  return (
    <>
      {fresh && (
        <div className="mt-4 overflow-hidden rounded-2xl bg-forest p-5 text-cream">
          <p className="text-[11px] font-bold tracking-[0.14em] text-crest uppercase">Referral reward · in your wallet</p>
          <p className="mt-1 text-xl leading-snug font-bold">🎉 {fresh.milestone > 1 ? 'Another milestone' : 'Congratulations'}{first ? `, ${first}` : ''}!</p>
          <p className="mt-1 text-sm leading-relaxed text-cream/85">
            You’ve reached {fresh.friends} verified friends on Jara. We’ve sent <b className="text-cream">{fresh.amountGd ? gd(fresh.amountGd) : 'your reward'}</b> (≈ {ngn(fresh.amountNgn)}) to your wallet. It’s yours to use.
          </p>
          <div className="mt-4 grid gap-2">
            {wallet && goodCashConfigured() && (
              <GoodCashCashOut userId={userId} wallet={wallet} flash={flash} amountG={fresh.amountGd ?? undefined} label="Cash out to my bank (naira)" className="app-button w-full justify-center bg-mandarin text-white hover:opacity-95 min-h-12 text-sm" />
            )}
            {onPay && (
              <button onClick={onPay} className="app-button w-full justify-center bg-cream/10 text-cream ring-1 ring-cream/25 hover:bg-cream/15 min-h-11 text-sm">
                Buy airtime or data with it
              </button>
            )}
          </div>
        </div>
      )}

      {sending && (
        <div className="mt-4 rounded-2xl bg-[#faf4dc] p-5">
          <p className="text-[11px] font-bold tracking-[0.14em] text-ink/50 uppercase">On its way</p>
          <p className="mt-1 font-bold">🎉 You’ve reached {sending.friends} verified friends! {sending.amountGd ? gd(sending.amountGd) : 'Your reward'} is being sent to your wallet.</p>
          <div className="mt-3 h-1.5 overflow-hidden rounded-full bg-ink/10"><div className="h-full w-2/3 animate-pulse rounded-full bg-mandarin" /></div>
          <p className="mt-2 text-xs font-semibold text-ink/55">Usually within a few minutes. Nothing for you to do.</p>
        </div>
      )}

      <div className="mt-4 rounded-2xl bg-[#f4f5ef] p-5">
        <div className="flex items-baseline justify-between gap-2">
          <p className="font-bold">{invited > 0 ? `You’ve invited ${invited} verified friend${invited === 1 ? '' : 's'}` : `Invite ${goal} friends, get ${prize}`}</p>
          <span className="shrink-0 text-sm font-bold text-forest">{invited}/{nextAt}</span>
        </div>
        <div className="mt-2 h-2 overflow-hidden rounded-full bg-ink/10">
          <div className="h-full rounded-full bg-mandarin transition-all" style={{ width: `${Math.max((towardNext / goal) * 100, 4)}%` }} />
        </div>
        <p className="mt-2 text-xs font-semibold text-ink/55">
          {nextAt - invited} more to reach {nextAt}, and {invited > 0 ? `your next ${prize}` : 'it'} lands in your wallet automatically. Every {goal} verified friends earns one.
        </p>
        {totalPaid > 0 && (
          <p className="mt-2 flex items-center gap-1.5 text-xs font-bold text-forest">
            <Icon name="check" className="h-3.5 w-3.5" strokeWidth={3} />
            {totalPaid} referral reward{totalPaid === 1 ? '' : 's'} paid
            {reward.sent.length > 0 && ` · ${gd(reward.sent.reduce((s, p) => s + (p.amountGd ?? 0), 0))} sent to your wallet`}
          </p>
        )}
      </div>
    </>
  )
}
