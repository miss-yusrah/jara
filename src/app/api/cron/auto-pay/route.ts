import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { runAutoPayForAll } from '@/lib/auto-pay'
import { serverConfig } from '@/lib/env'
import { MoneyBusyError } from '@/lib/money-lock'
import { payDueReferralMilestones } from '@/lib/rewards'
import { finalizeWinners, settleEarnings } from '@/lib/streak/service'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

export async function POST(req: Request) {
  const secret = serverConfig().cronSecret
  const got = Buffer.from(req.headers.get('authorization') ?? '')
  const want = Buffer.from(`Bearer ${secret}`)
  if (!secret || got.length !== want.length || !timingSafeEqual(got, want)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const results = await runAutoPayForAll()
    // Referral milestones: G$ to the wallet of anyone who just reached 10, 20, 30… verified friends.
    const referralMilestones = await payDueReferralMilestones().catch(() => 0)
    // Once Jara Streak closes, its winners are frozen on the next run; they then claim their prizes.
    const streakPrizes = await finalizeWinners().catch((err) => { console.warn('[streak] prizes will retry', err instanceof Error ? err.message : 'error'); return null })
    // Jara Streak G$ per correct answer still to send (runs that were abandoned, or a failed send).
    const streakEarnings = await settleEarnings().catch((err) => { console.warn('[streak] earnings will retry', err instanceof Error ? err.message : 'error'); return null })
    return NextResponse.json({ ran: results.length, results, referralMilestones, streakPrizes, streakEarnings })
  } catch (err) {
    if (err instanceof MoneyBusyError) return NextResponse.json({ skipped: 'A check is already running' })
    console.warn('[auto-pay] sweep failed')
    return NextResponse.json({ error: 'Auto-pay check will retry next minute' }, { status: 503 })
  }
}
