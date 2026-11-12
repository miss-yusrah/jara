import { after, NextResponse } from 'next/server'
import { apiFailure } from '@/lib/api-error'
import { SESSION_COOKIE, currentUser, setSessionCookie } from '@/lib/session'
import { settlePendingBills } from '@/lib/bills'
import { createUser, getUserById, consumeLinkCode, getUserByRefCode } from '@/lib/users'
import { clientIp, rateLimit } from '@/lib/ratelimit'
import { userState } from '../_shared'
import { recoverUserPayments } from '@/lib/money-recovery'

export const dynamic = 'force-dynamic'

export async function GET() {
  try { return await get() } catch (err) { return apiFailure(err, 'session') }
}

async function get() {
  const user = await currentUser()
  if (!user) return NextResponse.json({ user: null })
  // Bills still "processing" (e.g. FalconPay answered slowly): re-check them now instead of
  // waiting for the webhook or the scheduled run. At most every 20s per person.
  if (rateLimit(`settle:${user.id}`, 1, 20_000)) {
    after(async () => {
      await recoverUserPayments(user).catch((err) => console.warn('[session] payment recovery', err instanceof Error ? err.name : 'UnknownError'))
      await settlePendingBills(undefined, user.id).catch((err) => console.warn('[session] settle failed', err instanceof Error ? err.name : 'UnknownError'))
    })
  }
  return NextResponse.json(await userState((await getUserById(user.id)) ?? user))
}

export async function POST(req: Request) {
  const body = (await req.json().catch(() => ({}))) as { name?: string; tg?: string; ref?: string }
  // Arriving from the Telegram bot's "Set up" button: sign in as that chat's user.
  if (typeof body.tg === 'string' && body.tg) {
    const fromTg = await consumeLinkCode(body.tg)
    if (fromTg) {
      // Single use: the code in the Telegram button stops working once it has signed someone in.
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

// Sign out on this device. The account stays; connecting the same wallet signs back in.
export async function DELETE() {
  const res = NextResponse.json({ ok: true })
  res.cookies.set(SESSION_COOKIE, '', { httpOnly: true, sameSite: 'lax', secure: process.env.NODE_ENV === 'production', path: '/', maxAge: 0 })
  return res
}
