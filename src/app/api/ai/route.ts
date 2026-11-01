import { NextResponse } from 'next/server'
import { isAiTool, runAiTool } from '@/lib/ai-tools'
import { clientIp, rateLimit } from '@/lib/ratelimit'
import { requireUser } from '@/lib/session'
import { getUserById } from '@/lib/users'
import { bad, userState } from '../_shared'

export const dynamic = 'force-dynamic'
export const maxDuration = 60

// Run an AI helper, paid in G$ from the user's AI jar.
export async function POST(req: Request) {
  const user = await requireUser()
  if (user instanceof NextResponse) return user
  if (!user.connected) return bad('Connect your GoodDollar account first.')
  if (!rateLimit(`ai:${user.id}`, 10, 10 * 60_000) || !rateLimit(`ai-ip:${clientIp(req)}`, 30, 10 * 60_000)) {
    return NextResponse.json({ error: 'You’ve asked a lot just now — try again in a few minutes.' }, { status: 429 })
  }
  const body = (await req.json().catch(() => ({}))) as { tool?: string; input?: string }
  if (!isAiTool(body.tool)) return bad('Pick a helper')
  const r = await runAiTool(user, body.tool, String(body.input ?? ''))
  if (!r.ok) return bad(r.message ?? 'Something went wrong')
  return NextResponse.json({ output: r.output, costGd: r.costGd, demo: r.demo, state: await userState((await getUserById(user.id))!) })
}
