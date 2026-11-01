import { NextResponse } from 'next/server'
import { parseEther } from 'viem'
import { mockDeposit } from '@/lib/chain'
import { serverConfig } from '@/lib/env'
import { syncJars } from '@/lib/jars'
import { clientIp, rateLimit } from '@/lib/ratelimit'
import { requireUser } from '@/lib/session'
import { getUserById, logActivity, updateUser } from '@/lib/users'
import { lagosDay } from '@/lib/daily'
import { bad, userState } from '../../_shared'

export const dynamic = 'force-dynamic'

// Demo mode only: add G$ or fast-forward a day so the "week in Jara" can be shown live.
export async function POST(req: Request) {
  if (serverConfig().chain.mode !== 'mock') return bad('Demo tools are off', 404)
  const user = await requireUser()
  if (user instanceof NextResponse) return user
  if (!rateLimit(`demo:${user.id}`, 20, 60 * 60_000) || !rateLimit(`demo-ip:${clientIp(req)}`, 60, 60 * 60_000)) {
    return NextResponse.json({ error: 'Demo limit reached — try again later.' }, { status: 429 })
  }
  const body = (await req.json().catch(() => ({}))) as { action?: string; gd?: number }
  if (body.action === 'next-day') {
    await updateUser(user.id, { lastClaimDay: lagosDay(-1) })
  } else {
    const gd = Math.min(Math.max(Number(body.gd) || 5000, 1), 1_000_000)
    await mockDeposit(user.agentAddress, parseEther(String(gd)))
    await logActivity(user.id, { type: 'deposit', amountWei: parseEther(String(gd)).toString(), title: `Deposited G$ ${gd.toLocaleString()}` })
    await syncJars(user)
  }
  return NextResponse.json(await userState((await getUserById(user.id))!))
}
