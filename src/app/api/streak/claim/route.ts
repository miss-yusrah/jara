import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/session'
import { claimPrize } from '@/lib/streak/service'
import { streakFailure } from '@/lib/streak/http'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// A winner claims their share of the prize pool. Sent to their verified wallet, exactly once.
export async function POST() {
  try {
    const user = await requireUser()
    if (user instanceof NextResponse) return user
    return NextResponse.json(await claimPrize(user))
  } catch (err) { return streakFailure(err, 'streak-claim') }
}
