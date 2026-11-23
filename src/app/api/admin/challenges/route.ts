import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { ChallengeError, challengeAdminReport, drawChallenge, recordPrizeDelivery } from '@/lib/daily-challenge'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

function authorized(req: Request) {
  const key = process.env.ADMIN_KEY
  if (!key) return false
  const got = Buffer.from((req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, ''))
  const expected = Buffer.from(key)
  return got.length === expected.length && timingSafeEqual(got, expected)
}
function failure(error: unknown) {
  return NextResponse.json(
    {
      error:
        error instanceof ChallengeError
          ? error.message
          : 'Could not complete this operation. Retry to check the saved result.',
    },
    { status: error instanceof ChallengeError ? error.status : 503 },
  )
}
export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: 'Admin authentication required.' }, { status: 401 })
  try {
    return NextResponse.json(await challengeAdminReport(), { headers: { 'Cache-Control': 'no-store' } })
  } catch (error) {
    return failure(error)
  }
}
export async function POST(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: 'Admin authentication required.' }, { status: 401 })
  try {
    const body = await req.json().catch(() => null)
    if (!body || !Number.isSafeInteger(body.day)) throw new ChallengeError('Choose a campaign day.')
    if (body.action === 'draw') return NextResponse.json(await drawChallenge(body.day))
    if (body.action === 'delivered') {
      await recordPrizeDelivery(body.day, body.root, body.reference)
      return NextResponse.json({ recorded: true })
    }
    throw new ChallengeError('Unknown campaign action.')
  } catch (error) {
    return failure(error)
  }
}
