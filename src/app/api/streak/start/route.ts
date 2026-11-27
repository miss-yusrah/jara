import { after, NextResponse } from 'next/server'
import { requireUser } from '@/lib/session'
import { settlePlayer, startRun } from '@/lib/streak/service'
import { streakFailure } from '@/lib/streak/http'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Start a run (or resume the one in play). { campus, name? } the first time. Any G$ still owed from
// an earlier run (one that was abandoned, say) is sent after the response.
export async function POST(req: Request) {
  try {
    const user = await requireUser()
    if (user instanceof NextResponse) return user
    const body = (await req.json().catch(() => ({}))) as { campus?: unknown; name?: unknown }
    const out = await startRun(user, body)
    after(() => settlePlayer(user).catch(() => undefined))
    return NextResponse.json(out)
  } catch (err) { return streakFailure(err, 'streak-start') }
}
