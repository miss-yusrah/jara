import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { serverConfig } from '@/lib/env'
import { finalizeWinners } from '@/lib/streak/service'
import { streakFailure } from '@/lib/streak/http'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

// After the bounty closes: freeze the winners (once). Winners then claim their prize in the app. The
// auto-pay cron also does this every run, so this is only for checking by hand. Safe to call again.
// Header: Authorization: Bearer $CRON_SECRET
export async function POST(req: Request) {
  const secret = serverConfig().cronSecret
  const got = Buffer.from(req.headers.get('authorization') ?? '')
  const want = Buffer.from(`Bearer ${secret}`)
  if (!secret || got.length !== want.length || !timingSafeEqual(got, want)) return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  try { return NextResponse.json(await finalizeWinners()) }
  catch (err) { return streakFailure(err, 'streak-pay-winners') }
}
