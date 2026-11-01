import { NextResponse } from 'next/server'
import { runDaily } from '@/lib/daily'
import { requireUser } from '@/lib/session'
import { getUserById } from '@/lib/users'
import { bad, userState } from '../_shared'

export const dynamic = 'force-dynamic'

export async function POST() {
  const user = await requireUser()
  if (user instanceof NextResponse) return user
  if (!user.connected) return bad('Connect your GoodDollar account first.')
  try {
    const r = await runDaily(user)
    return NextResponse.json({ message: r.claimed > 0n ? r.message : 'Already claimed today — I will claim again tomorrow.', state: await userState((await getUserById(user.id))!) })
  } catch (err) {
    console.error('[claim]', err)
    return bad('Claim failed. Please try again shortly.', 502)
  }
}
