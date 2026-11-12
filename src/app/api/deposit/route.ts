import { NextResponse } from 'next/server'
import { formatEther, isHash } from 'viem'
import { gdReceivedIn } from '@/lib/chain'
import { run } from '@/lib/db'
import { serverConfig } from '@/lib/env'
import { syncJars, withUserLock } from '@/lib/jars'
import { requireUser } from '@/lib/session'
import { getUserById, logActivity } from '@/lib/users'
import { bad, userState } from '../_shared'

export const dynamic = 'force-dynamic'

// The person sent G$ from their own wallet to their jar address. Confirm it on-chain,
// log it once, and share it out across their jars.
export async function POST(req: Request) {
  if (serverConfig().chain.mode === 'mock') return bad('Use the demo deposit in mock mode', 404)
  const user = await requireUser()
  if (user instanceof NextResponse) return user
  const { hash } = (await req.json().catch(() => ({}))) as { hash?: string }

  await withUserLock(user.id, async () => {
    if (hash && isHash(hash)) {
      const seen = await run('SELECT 1 FROM activity WHERE user_id = ? AND tx_hash = ? LIMIT 1', [user.id, hash])
      if (seen.rows.length === 0) {
        const amount = await gdReceivedIn(hash, user.agentAddress)
        if (amount > 0n) {
          await logActivity(user.id, {
            type: 'deposit',
            amountWei: amount.toString(),
            txHash: hash,
            title: `Added G$ ${Number(formatEther(amount)).toLocaleString('en-US', { maximumFractionDigits: 0 })} from your wallet`,
          })
        }
      }
    }
    // Also picks up G$ sent to the jar address any other way.
    await syncJars(user)
  })
  return NextResponse.json(await userState((await getUserById(user.id))!))
}
