import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/session'
import { joinStreak } from '@/lib/streak/service'
import { streakFailure } from '@/lib/streak/http'

export const dynamic = 'force-dynamic'

// { campus, name? }: join the bounty: the school (set once) and, if the account has none, a name.
export async function POST(req: Request) {
  try {
    const user = await requireUser()
    if (user instanceof NextResponse) return user
    const body = (await req.json().catch(() => ({}))) as { campus?: unknown; name?: unknown }
    return NextResponse.json(await joinStreak(user, body))
  } catch (err) { return streakFailure(err, 'streak-campus') }
}
