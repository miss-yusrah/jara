import { NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { referralPayoutReport } from '@/lib/referral-payout'

export const dynamic = 'force-dynamic'

function authorized(req: Request): boolean {
  const key = process.env.ADMIN_KEY
  if (!key) return false
  const a = Buffer.from((req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, ''))
  const b = Buffer.from(key)
  return a.length === b.length && timingSafeEqual(a, b)
}

/** The referral wallet (address, G$ and CELO left) and every milestone payout, newest first. */
export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: process.env.ADMIN_KEY ? 'Wrong admin key' : 'Set ADMIN_KEY on the server first' }, { status: 401 })
  return NextResponse.json(await referralPayoutReport())
}
