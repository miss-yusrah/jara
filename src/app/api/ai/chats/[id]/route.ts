import { NextResponse } from 'next/server'
import { deleteChat, getChat } from '@/lib/ai-chat'
import { requireUser } from '@/lib/session'

export const dynamic = 'force-dynamic'

export async function GET(_req: Request, ctx: RouteContext<'/api/ai/chats/[id]'>) {
  const user = await requireUser()
  if (user instanceof NextResponse) return user
  const chat = await getChat(user.id, (await ctx.params).id)
  if (!chat) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(chat)
}

export async function DELETE(_req: Request, ctx: RouteContext<'/api/ai/chats/[id]'>) {
  const user = await requireUser()
  if (user instanceof NextResponse) return user
  await deleteChat(user.id, (await ctx.params).id)
  return NextResponse.json({ ok: true })
}
