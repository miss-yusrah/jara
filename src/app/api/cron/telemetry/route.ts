import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { serverConfig } from '@/lib/env'
import { flushTelemetry } from '@/lib/telemetry'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

// Writes pending app activity to the JaraTelemetry contract on Celo. Header: Authorization: Bearer $CRON_SECRET
export const POST = GET

export async function GET(req: Request) {
  const secret = serverConfig().cronSecret
  const got = Buffer.from(req.headers.get('authorization') ?? '')
  const want = Buffer.from(`Bearer ${secret}`)
  if (!secret || got.length !== want.length || !timingSafeEqual(got, want)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  try {
    return NextResponse.json(await flushTelemetry())
  } catch (err) {
    console.error('[telemetry] flush failed', err)
    return NextResponse.json({ error: err instanceof Error ? err.message : 'flush failed' }, { status: 500 })
  }
}
