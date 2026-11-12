import { NextResponse } from 'next/server'
import { getOwnedMessage } from '@/lib/ai-chat'
import { AI_TOOLS } from '@/lib/ai-tools'
import { renderAnswerPdf } from '@/lib/pdf'
import { requireUser } from '@/lib/session'

export const dynamic = 'force-dynamic'
export const runtime = 'nodejs'

// Download one Jara AI answer as a formatted PDF.
export async function GET(_req: Request, ctx: RouteContext<'/api/ai/pdf/[id]'>) {
  const user = await requireUser()
  if (user instanceof NextResponse) return user
  const id = Number((await ctx.params).id)
  if (!Number.isInteger(id)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const msg = await getOwnedMessage(user.id, id)
  if (!msg) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  const pdf = await renderAnswerPdf({ markdown: msg.content, kind: AI_TOOLS[msg.tool].name, question: msg.question, date: new Date(msg.createdAt), author: user.name ?? undefined })
  const slug = (msg.content.match(/^#\s+(.+)$/m)?.[1] ?? msg.title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 60) || 'jara-answer'
  return new Response(new Uint8Array(pdf), {
    headers: { 'content-type': 'application/pdf', 'content-disposition': `attachment; filename="${slug}.pdf"`, 'cache-control': 'private, no-store' },
  })
}
