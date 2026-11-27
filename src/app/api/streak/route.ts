import { NextResponse } from 'next/server'
import { currentUser } from '@/lib/session'
import { streakHome } from '@/lib/streak/service'
import { streakFailure } from '@/lib/streak/http'

export const dynamic = 'force-dynamic'

// The Jara Streak screen: the bounty window, this player's runs and best, and a run in progress.
export async function GET() {
  try { return NextResponse.json(await streakHome(await currentUser())) }
  catch (err) { return streakFailure(err, 'streak') }
}
