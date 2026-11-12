import { NextResponse } from 'next/server'
import { telemetrySummary } from '@/lib/telemetry'

export const dynamic = 'force-dynamic'

let cache: { at: number; body: unknown } | null = null

// Public on-chain totals from the JaraTelemetry contract (users and G$ circulation).
export async function GET() {
  if (cache && Date.now() - cache.at < 60_000) return NextResponse.json(cache.body)
  try {
    const body = (await telemetrySummary()) ?? { contract: null, note: 'Telemetry contract not configured yet' }
    cache = { at: Date.now(), body }
    return NextResponse.json(body)
  } catch (err) {
    console.error('[telemetry] summary failed', err)
    return NextResponse.json({ error: 'Could not read the contract right now' }, { status: 502 })
  }
}
