import { NextResponse } from 'next/server'
import { runAgent } from '@/lib/agent/routine'
import { clientIp, rateLimit } from '@/lib/ratelimit'
import { requireUser } from '@/lib/session'
import { getUserById } from '@/lib/users'
import { bad, userState } from '../../_shared'

export const dynamic = 'force-dynamic'

// Run the agent's routine now (the cron runs it on a schedule).
export async function POST(req: Request) {
  const user = await requireUser()
  if (user instanceof NextResponse) return user
  if (!rateLimit(`run:${user.id}`, 12, 10 * 60_000) || !rateLimit(`run-ip:${clientIp(req)}`, 36, 10 * 60_000)) {
    return NextResponse.json({ error: 'Jara just checked in — give it a few minutes.' }, { status: 429 })
  }
  if (!user.connected) return bad('Connect your GoodDollar account first.')
  try {
    const r = await runAgent(user.id)
    return NextResponse.json({ steps: r.steps, message: r.message, state: await userState((await getUserById(user.id))!) })
  } catch (err) {
    console.error('[agent/run]', err)
    return bad('Jara hit a snag. Try again shortly.', 502)
  }
}
