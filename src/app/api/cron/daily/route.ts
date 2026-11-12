import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { runAgentForAll } from '@/lib/agent/routine'
import { serverConfig } from '@/lib/env'
import { sendMessage } from '@/lib/telegram'
import { flushTelemetry } from '@/lib/telemetry'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

// Run the agent for every user, e.g. every 6 hours (claims are once per day). Header: Authorization: Bearer $CRON_SECRET
export const POST = GET

export async function GET(req: Request) {
  const secret = serverConfig().cronSecret
  const got = Buffer.from(req.headers.get('authorization') ?? '')
  const want = Buffer.from(`Bearer ${secret}`)
  if (!secret || got.length !== want.length || !timingSafeEqual(got, want)) {
    return NextResponse.json({ error: 'Unauthorized' }, { status: 401 })
  }
  const results = await runAgentForAll(async (user, text) => {
    if (user.tgChatId) await sendMessage(user.tgChatId, text)
  })
  const telemetry = await flushTelemetry().catch((err) => ({ error: err instanceof Error ? err.message : String(err) }))
  return NextResponse.json({ ran: results.length, results, telemetry })
}
