import { NextResponse } from 'next/server'
import { currentUser, setSessionCookie } from '@/lib/session'
import { createUser, getUserByLinkCode, getUserByRefCode, rotateLinkCode } from '@/lib/users'
import { clientIp, rateLimit } from '@/lib/ratelimit'
import { userState } from '../_shared'

export const dynamic = 'force-dynamic'

export async function GET() {
  const user = await currentUser()
  if (!user) return NextResponse.json({ user: null })
  return NextResponse.json(await userState(user))
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { name?: string; tg?: string; ref?: string }
  // Arriving from the Telegram bot's "Set up" button: sign in as that chat's user.
  if (typeof body.tg === 'string' && body.tg) {
    const fromTg = await getUserByLinkCode(body.tg)
    if (fromTg) {
      // Single use: the code in the Telegram button stops working once it has signed someone in.
      await rotateLinkCode(fromTg.id)
      const res = NextResponse.json(await userState(fromTg))
      setSessionCookie(res, fromTg.sessionToken)
      return res
    }
    if (!(await currentUser())) return NextResponse.json({ error: 'This link has expired. Send /start to the bot for a fresh one.' }, { status: 410 })
  }
  const existing = await currentUser()
  if (existing) return NextResponse.json(await userState(existing))
  if (!rateLimit(`signup:${clientIp(req)}`, 10, 60 * 60_000)) {
    return NextResponse.json({ error: 'Too many new accounts from this network. Try again later.' }, { status: 429 })
  }
  const name = typeof body.name === 'string' ? body.name.trim().slice(0, 40) || undefined : undefined
  const referrer = typeof body.ref === 'string' && body.ref ? await getUserByRefCode(body.ref) : null
  const user = await createUser({ name, referredBy: referrer?.id })
  const res = NextResponse.json(await userState(user))
  setSessionCookie(res, user.sessionToken)
  return res
}
