import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { runDailyForAll } from '@/lib/daily'
import { serverConfig } from '@/lib/env'
import { MoneyBusyError, withMoneyLock } from '@/lib/money-lock'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

/** Hourly claim retries, independent of paid AI jobs and outbound notifications. */
export async function POST(req: Request) {
  const secret = serverConfig().cronSecret
  const got = Buffer.from(req.headers.get('authorization') ?? '')
  const want = Buffer.from(`Bearer ${secret}`)
  if (!secret || got.length !== want.length || !timingSafeEqual(got, want)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    const results = await withMoneyLock('cron:claims', () => runDailyForAll(async () => {}))
    return NextResponse.json({ ran: results.length, results })
  } catch (err) {
    if (err instanceof MoneyBusyError) return NextResponse.json({ skipped: 'A claim check is already running' })
    console.warn('[claims] sweep failed')
    return NextResponse.json({ error: 'Claim check will retry next hour' }, { status: 503 })
  }
}
