import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/session'
import {
  ChallengeError,
  challengeView,
  prepareChallengeEntry,
  savePrizePhone,
  submitChallenge,
} from '@/lib/daily-challenge'
import { rateLimit } from '@/lib/ratelimit'

export const dynamic = 'force-dynamic'

function failure(error: unknown) {
  if (error instanceof ChallengeError) return NextResponse.json({ error: error.message }, { status: error.status })
  console.error('[daily-challenge]', error instanceof Error ? error.name : 'UnknownError')
  return NextResponse.json(
    {
      error: 'Could not check the challenge right now. Your confirmed on-chain entry is preserved. Try again shortly.',
    },
    { status: 503 },
  )
}

export async function GET() {
  try {
    const user = await requireUser()
    if (user instanceof NextResponse) return user
    return NextResponse.json(await challengeView(user), { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    return failure(error)
  }
}

export async function POST(req: Request) {
  try {
    const user = await requireUser()
    if (user instanceof NextResponse) return user
    if (!rateLimit(`daily-challenge:${user.id}`, 30, 60_000))
      return NextResponse.json({ error: 'Please wait a moment before trying again.' }, { status: 429 })
    if (!req.headers.get('content-type')?.includes('application/json')) throw new ChallengeError('Send a JSON request.')
    const body = await req.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body) || !Number.isSafeInteger(body.day))
      throw new ChallengeError('Invalid challenge request.')
    if (body.action === 'submit') return NextResponse.json(await submitChallenge(user, body.day, body.answers))
    if (body.action === 'prepare' && body.reviewed === true)
      return NextResponse.json(await prepareChallengeEntry(user, body.day))
    if (body.action === 'prize') {
      await savePrizePhone(user, body.day, body.phone, body.network)
      return NextResponse.json({ saved: true })
    }
    throw new ChallengeError('Choose a valid challenge action.')
  } catch (error) {
    return failure(error)
  }
}
