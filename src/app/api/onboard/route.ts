import { NextResponse } from 'next/server'
import { getAddress, isAddress } from 'viem'
import { topUpFromFaucet, whitelistedRoot } from '@/lib/chain'
import { serverConfig } from '@/lib/env'
import { runDaily } from '@/lib/daily'
import { requireUser } from '@/lib/session'
import { getUserById, logActivity, updateUser } from '@/lib/users'
import { bad, userState } from '../_shared'
import { withUserLock } from '@/lib/jars'
import { WALLET_LINKED_MESSAGE, accountForWallet, bindWallet } from '@/lib/wallet-authorization'
import { activateClaimer, prepareClaimer } from '@/lib/claimers'

export const dynamic = 'force-dynamic'

// Step 1: user tells us their verified GoodDollar address.
// Step 2: they connect our agent wallet to it (connectAccount, signed in their wallet).
// Step 3: we confirm on-chain that the agent wallet now resolves to their identity.
export async function POST(req: Request) {
  const user = await requireUser()
  if (user instanceof NextResponse) return user
  const body = (await req.json().catch(() => ({}))) as { action?: string; address?: string; issuedAt?: number; signature?: string }
  const mock = serverConfig().chain.mode === 'mock'

  return withUserLock(user.id, async () => {
    let fresh = (await getUserById(user.id))!

    if (body.action === 'prepare-claimer') {
      try { return NextResponse.json(await userState(await prepareClaimer(fresh))) }
      catch (err) { return bad(err instanceof Error ? err.message : 'Could not prepare the claim contract.') }
    }

    if (body.action === 'root') {
      if (fresh.connected) return bad('Your connected wallet cannot be changed here. Disconnect the existing identity link before setting up another account.', 409)
      if (!body.address || !isAddress(body.address)) return bad('That does not look like a wallet address (0x…).')
      const address = getAddress(body.address)
      if (!mock) {
        // Same wallet as an existing account (new phone, cleared browser): offer to sign back in.
        const existing = (await accountForWallet(address, user.id)) ?? ((await whitelistedRoot(address)) ? await accountForWallet((await whitelistedRoot(address))!, user.id) : null)
        if (existing) return NextResponse.json({ error: WALLET_LINKED_MESSAGE, code: 'wallet_linked', address }, { status: 409 })
        const root = await whitelistedRoot(address)
        if (!root) {
          return NextResponse.json(
            { error: 'This wallet is not verified on GoodDollar yet.', code: 'not_verified', address },
            { status: 400 },
          )
        }
        await updateUser(user.id, { rootAddress: root })
        // Free gas for the two setup approvals (matters for new Google-login wallets with no CELO).
        await topUpFromFaucet(root).catch((err) => console.warn('[onboard] faucet top-up skipped', err instanceof Error ? err.message : err))
      } else {
        await updateUser(user.id, { rootAddress: address })
      }
      if (!mock && serverConfig().chain.claimerFactory) {
        try { await prepareClaimer((await getUserById(user.id))!) }
        catch (err) { return bad(err instanceof Error ? err.message : 'Could not prepare the claim contract.') }
      }
      return NextResponse.json(await userState((await getUserById(user.id))!))
    }

    if (body.action === 'check') {
      if (!fresh.rootAddress) return bad('Add your GoodDollar address first.')
      if (!mock && (fresh.claimerAddress || serverConfig().chain.claimerFactory || fresh.agentKeyEnc === 'keyless')) {
        try {
          fresh = await activateClaimer(fresh, body)
          await runDaily(fresh).catch((err) => console.warn('[onboard] first keyless claim deferred', err instanceof Error ? err.message : 'error'))
          return NextResponse.json(await userState(fresh))
        } catch (err) { return bad(err instanceof Error ? err.message : 'Could not activate keyless claims.') }
      }
      let ok = false
      if (mock) ok = true
      else {
        const root = await whitelistedRoot(user.agentAddress)
        ok = root?.toLowerCase() === fresh.rootAddress.toLowerCase()
      }
      if (!ok) return bad('Not connected yet. Approve the "connect account" transaction in your wallet, then check again.')
      if (!mock) {
        try { await bindWallet(user.id, fresh.rootAddress) }
        catch (err) { return NextResponse.json({ error: err instanceof Error ? err.message : WALLET_LINKED_MESSAGE, code: 'wallet_linked', address: fresh.rootAddress }, { status: 409 }) }
      }
      if (!fresh.connected) {
        await updateUser(user.id, { connected: true })
        await logActivity(user.id, { type: 'move', title: 'Jara connected to your GoodDollar account 🎉' })
        // First claim right away so new people can use Jara AI immediately.
        await runDaily((await getUserById(user.id))!).catch((err) => console.warn('[onboard] first claim failed', err))
      }
      return NextResponse.json(await userState((await getUserById(user.id))!))
    }

    if (body.action === 'name' && typeof body.address === 'string') {
      await updateUser(user.id, { name: body.address.trim().slice(0, 40) || null })
      return NextResponse.json(await userState((await getUserById(user.id))!))
    }

    return bad('Unknown action')
  })
}
