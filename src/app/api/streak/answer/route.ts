import { after, NextResponse } from 'next/server'
import { requireUser } from '@/lib/session'
import { answer, settlePlayer } from '@/lib/streak/service'
import { streakFailure } from '@/lib/streak/http'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// { runId, index, choice } or { runId, index, timeout: true }. Scored against the server's clock.
// When the run ends, its G$ is sent after the response, so the result screen is never kept waiting.
export async function POST(req: Request) {
  try {
    const user = await requireUser()
    if (user instanceof NextResponse) return user
    const body = (await req.json().catch(() => ({}))) as { runId?: unknown; index?: unknown; choice?: unknown; timeout?: unknown }
    const out = await answer(user, body)
    if (out.run.finished && out.run.earnedGd > 0) after(() => settlePlayer(user).catch(() => undefined))
    return NextResponse.json(out)
  } catch (err) { return streakFailure(err, 'streak-answer') }
}
