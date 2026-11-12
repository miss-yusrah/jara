import { apiFailure } from '@/lib/api-error'
import { NextResponse } from 'next/server'
import { listChats } from '@/lib/ai-chat'
import { AI_TOOLS, followUpPrice, type AiToolId } from '@/lib/ai-tools'
import { snapshot } from '@/lib/jars'
import { requireUser } from '@/lib/session'

export const dynamic = 'force-dynamic'

async function get() {
  const user = await requireUser()
  if (user instanceof NextResponse) return user
  const [chats, snap] = await Promise.all([listChats(user.id), snapshot(user)])
  return NextResponse.json({
    user: { name: user.name, connected: user.connected },
    chats,
    balanceGd: snap.totalGd,
    aiJarGd: snap.jars.find((j) => j.kind === 'ai')?.balanceGd ?? 0,
    tools: (Object.keys(AI_TOOLS) as AiToolId[]).map((id) => ({
      id,
      name: AI_TOOLS[id].name,
      blurb: AI_TOOLS[id].blurb,
      placeholder: AI_TOOLS[id].placeholder,
      priceGd: AI_TOOLS[id].priceGd,
      followUpGd: followUpPrice(id),
    })),
  })
}

export async function GET() {
  try { return await get() } catch (err) { return apiFailure(err, 'ai/chats') }
}
