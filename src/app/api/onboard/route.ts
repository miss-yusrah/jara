import { NextResponse } from 'next/server'
import { getAddress, isAddress } from 'viem'
import { whitelistedRoot } from '@/lib/chain'
import { serverConfig } from '@/lib/env'
import { requireUser } from '@/lib/session'
import { getUserById, logActivity, updateUser } from '@/lib/users'
import { bad, userState } from '../_shared'

export const dynamic = 'force-dynamic'

// Step 1: user tells us their verified GoodDollar address.
// Step 2: they connect our agent wallet to it (connectAccount, signed in their wallet).
// Step 3: we confirm on-chain that the agent wallet now resolves to their identity.
export async function POST(req: Request) {
  const user = await requireUser()
  if (user instanceof NextResponse) return user
  const body = (await req.json().catch(() => ({}))) as { action?: string; address?: string }
  const mock = serverConfig().chain.mode === 'mock'

  if (body.action === 'root') {
    if (!body.address || !isAddress(body.address)) return bad('That does not look like a wallet address (0x…).')
    const address = getAddress(body.address)
    if (!mock) {
      const root = await whitelistedRoot(address)
      if (!root) return bad('This address is not verified on GoodDollar yet. Verify your face in GoodWallet first, then come back.')
      await updateUser(user.id, { rootAddress: root })
    } else {
      await updateUser(user.id, { rootAddress: address })
    }
    return NextResponse.json(await userState((await getUserById(user.id))!))
  }

  if (body.action === 'check') {
    if (!user.rootAddress) return bad('Add your GoodDollar address first.')
    let ok = false
    if (mock) ok = true
    else {
      const root = await whitelistedRoot(user.agentAddress)
      ok = root?.toLowerCase() === user.rootAddress.toLowerCase()
    }
    if (!ok) return bad('Not connected yet. Approve the "connect account" transaction in your wallet, then check again.')
    if (!user.connected) {
      await updateUser(user.id, { connected: true })
      await logActivity(user.id, { type: 'move', title: 'Jara connected to your GoodDollar account 🎉' })
    }
    return NextResponse.json(await userState((await getUserById(user.id))!))
  }

  if (body.action === 'name' && typeof body.address === 'string') {
    await updateUser(user.id, { name: body.address.trim().slice(0, 40) || null })
    return NextResponse.json(await userState((await getUserById(user.id))!))
  }

  return bad('Unknown action')
}
