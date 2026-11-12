import { apiFailure } from '@/lib/api-error'
import { NextResponse } from 'next/server'
import { deleteChat, getChat } from '@/lib/ai-chat'
import { requireUser } from '@/lib/session'

export const dynamic = 'force-dynamic'

async function get(_req: Request, ctx: RouteContext<'/api/ai/chats/[id]'>) {
  const user = await requireUser()
  if (user instanceof NextResponse) return user
  const chat = await getChat(user.id, (await ctx.params).id)
  if (!chat) return NextResponse.json({ error: 'Not found' }, { status: 404 })
  return NextResponse.json(chat)
}

async function remove(_req: Request, ctx: RouteContext<'/api/ai/chats/[id]'>) {
  const user = await requireUser()
  if (user instanceof NextResponse) return user
  await deleteChat(user.id, (await ctx.params).id)
  return NextResponse.json({ ok: true })
}

export async function GET(req: Request, ctx: RouteContext<'/api/ai/chats/[id]'>) {
  try { return await get(req, ctx) } catch (err) { return apiFailure(err, 'ai/chats/[id]') }
}

export async function DELETE(req: Request, ctx: RouteContext<'/api/ai/chats/[id]'>) {
  try { return await remove(req, ctx) } catch (err) { return apiFailure(err, 'ai/chats/[id]') }
}
