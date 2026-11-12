import { requestKey } from '@/lib/money-request'
import { NextResponse } from 'next/server'
import { handleMessage, resolvePending } from '@/lib/agent'
import { run } from '@/lib/db'
import { clientIp, rateLimit } from '@/lib/ratelimit'
import { requireUser } from '@/lib/session'
import { getUserById } from '@/lib/users'
import { bad, userState } from '../_shared'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const user = await requireUser()
  if (user instanceof NextResponse) return user
  if (!rateLimit(`chat:${user.id}`, 30, 10 * 60_000) || !rateLimit(`chat-ip:${clientIp(req)}`, 90, 10 * 60_000)) {
    return NextResponse.json({ error: 'Slow down a little — try again in a few minutes.' }, { status: 429 })
  }
  const body = (await req.json().catch(() => ({}))) as { requestId?: string; text?: string; confirm?: boolean; actionId?: string }
  let requestId: string
  try { requestId = requestKey(body.requestId) } catch { return NextResponse.json({ error: 'A request ID is required. Refresh and try again.' }, { status: 400 }) }
  let reply
  if (typeof body.confirm === 'boolean') {
    if (!body.actionId) return bad('Review this bill again before confirming.')
    reply = await resolvePending(user.id, body.confirm, body.actionId)
    await run('INSERT INTO messages (user_id, role, content, created_at) VALUES (?, ?, ?, ?)', [user.id, 'assistant', reply.text, Date.now()])
  } else {
    const text = typeof body.text === 'string' ? body.text.trim().slice(0, 500) : ''
    if (!text) return bad('Say something')
    reply = await handleMessage(user.id, text, requestId)
  }
  return NextResponse.json({ reply, state: await userState((await getUserById(user.id))!) })
}
