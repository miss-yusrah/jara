import { NextResponse } from 'next/server'
import { runDaily } from '@/lib/daily'
import { requireUser } from '@/lib/session'
import { getUserById } from '@/lib/users'
import { bad, userState } from '../_shared'
import { claimHealth } from '@/lib/claim-health'
import { apiFailure } from '@/lib/api-error'

export const dynamic = 'force-dynamic'

export async function GET() {
  const user = await requireUser()
  if (user instanceof NextResponse) return user
  return NextResponse.json(await claimHealth(user), { headers: { 'Cache-Control': 'no-store' } })
}

export async function POST() {
  const user = await requireUser()
  if (user instanceof NextResponse) return user
  if (!user.connected) return bad('Connect your GoodDollar account first.')
  try {
    const r = await runDaily(user)
    return NextResponse.json({ message: r.message, claimStatus: r.claimStatus, state: await userState((await getUserById(user.id))!) })
  } catch (err) {
    return apiFailure(err, 'claim')
  }
}
