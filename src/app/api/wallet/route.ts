import { requestKey } from '@/lib/money-request'
import { NextResponse } from 'next/server'
import { syncJars, withUserLock } from '@/lib/jars'
import { requireUser } from '@/lib/session'
import { gdText, withdrawToWallet } from '@/lib/spend'
import { getUserById, logActivity } from '@/lib/users'
import { bad, userState } from '../_shared'

export const dynamic = 'force-dynamic'

// withdraw: move the G$ Jara claimed into the person's own wallet.
// refresh:  re-read balances after they changed their spending limit in their wallet.
export async function POST(req: Request) {
  const user = await requireUser()
  if (user instanceof NextResponse) return user
  const { action, requestId } = (await req.json().catch(() => ({}))) as { action?: string; requestId?: string }

  if (action === 'withdraw') {
    try {
      await withUserLock(user.id, async () => {
        const r = await withdrawToWallet(user, requestKey(requestId))
        if (!r) throw new Error('There’s no claimed G$ to move yet.')
        await logActivity(user.id, { type: 'move', amountWei: r.amountWei.toString(), txHash: r.hash, title: `Sent ${gdText(r.amountWei)} to your wallet` })
        await syncJars(user)
      })
    } catch (err) {
      return bad(err instanceof Error ? err.message.split('\n')[0] : 'Could not move your G$')
    }
  } else if (action === 'refresh') {
    await withUserLock(user.id, () => syncJars(user))
  } else {
    return bad('Unknown action')
  }
  return NextResponse.json(await userState((await getUserById(user.id))!))
}
