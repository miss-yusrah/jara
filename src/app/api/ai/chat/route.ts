import { requestKey } from '@/lib/money-request'
import { NextResponse } from 'next/server'
import { sendChat } from '@/lib/ai-chat'
import { isAiTool } from '@/lib/ai-tools'
import { clientIp, rateLimit } from '@/lib/ratelimit'
import { requireUser } from '@/lib/session'

export const dynamic = 'force-dynamic'
export const maxDuration = 300

// Streams newline-delimited JSON events: chat, delta…, then done or error.
export async function POST(req: Request) {
  const user = await requireUser()
  if (user instanceof NextResponse) return user
  if (!user.connected) return NextResponse.json({ error: 'Connect your GoodDollar account first.' }, { status: 400 })
  if (!rateLimit(`ai:${user.id}`, 15, 10 * 60_000) || !rateLimit(`ai-ip:${clientIp(req)}`, 45, 10 * 60_000)) {
    return NextResponse.json({ error: 'You’ve asked a lot just now. Try again in a few minutes.' }, { status: 429 })
  }
  const body = (await req.json().catch(() => ({}))) as { requestId?: string; chatId?: string; tool?: string; text?: string }
  let requestId: string
  try { requestId = requestKey(body.requestId) } catch { return NextResponse.json({ error: 'A request ID is required. Refresh and try again.' }, { status: 400 }) }
  if (!body.chatId && !isAiTool(body.tool)) return NextResponse.json({ error: 'Pick a helper' }, { status: 400 })
  const tool = isAiTool(body.tool) ? body.tool : 'research'

  const enc = new TextEncoder()
  const stream = new ReadableStream({
    async start(controller) {
      try {
        for await (const ev of sendChat(user, { requestId, chatId: body.chatId, tool, text: String(body.text ?? '') })) {
          controller.enqueue(enc.encode(JSON.stringify(ev) + '\n'))
        }
      } catch {
        controller.enqueue(enc.encode(JSON.stringify({ t: 'error', message: 'The result is not confirmed. Retry the same request to check its status.' }) + '\n'))
      }
      controller.close()
    },
  })
  return new Response(stream, {
    headers: { 'content-type': 'application/x-ndjson; charset=utf-8', 'cache-control': 'no-store', 'x-accel-buffering': 'no' },
  })
}
