import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { streakReport } from '@/lib/streak/service'
import { streakFailure } from '@/lib/streak/http'

export const dynamic = 'force-dynamic'

function authorized(req: Request): boolean {
  const key = process.env.ADMIN_KEY
  if (!key) return false
  const a = Buffer.from((req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, ''))
  const b = Buffer.from(key)
  return a.length === b.length && timingSafeEqual(a, b)
}

// Jara Streak, all accounted for: players, schools, runs and answers, G$ earned per correct answer
// (and how much has reached wallets), the pool left, and the prizes.
// Header: Authorization: Bearer $ADMIN_KEY
export async function GET(req: Request) {
  if (!authorized(req)) return NextResponse.json({ error: process.env.ADMIN_KEY ? 'Wrong admin key' : 'Set ADMIN_KEY on the server first' }, { status: 401 })
  try { return NextResponse.json(await streakReport()) }
  catch (err) { return streakFailure(err, 'admin-streak') }
}
