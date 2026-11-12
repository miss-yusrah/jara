import { scheduleAutoPay } from '@/lib/auto-pay-after'
import { requestKey } from '@/lib/money-request'
import { run } from '@/lib/db'
import { NextResponse } from 'next/server'
import { syncJars, withUserLock } from '@/lib/jars'
import { requireUser } from '@/lib/session'
import { gdText, withdrawToWallet } from '@/lib/spend'
import { getUserById } from '@/lib/users'
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
        const key = requestKey(requestId)
        const r = await withdrawToWallet(user, key)
        if (!r) throw new Error('There’s no claimed G$ to move yet.')
        await run(`INSERT OR IGNORE INTO activity (user_id, type, amount_wei, tx_hash, title, created_at, operation_id)
          VALUES (?, 'move', ?, ?, ?, ?, ?)`,
        [user.id, String(r.amountWei), r.hash, `Sent ${gdText(r.amountWei)} to your wallet`, Date.now(), `${user.id}:withdraw:${key}`])
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
  scheduleAutoPay(user.id)
  return NextResponse.json(await userState((await getUserById(user.id))!))
}
