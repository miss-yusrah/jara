import { NextResponse } from 'next/server'
import { createPublicClient, getAddress, http, isAddress, isHex } from 'viem'
import { celo } from 'viem/chains'
import { whitelistedRoot } from '@/lib/chain'
import { run } from '@/lib/db'
import { serverConfig } from '@/lib/env'
import { clientIp, rateLimit } from '@/lib/ratelimit'
import { setSessionCookie } from '@/lib/session'
import { getUserById } from '@/lib/users'
import { accountForWallet } from '@/lib/wallet-authorization'
import { walletLoginMessage } from '@/lib/wallet-login'
import { userState } from '../../_shared'

export const dynamic = 'force-dynamic'

const WINDOW_MS = 10 * 60_000

// Sign back in to the Jara account a GoodDollar wallet belongs to (new phone, cleared
// browser). Proof is a signature from that wallet, never just knowing the address.
export async function POST(req: Request) {
  if (!rateLimit(`wallet-login:${clientIp(req)}`, 10, 10 * 60_000)) {
    return NextResponse.json({ error: 'Too many tries. Wait a few minutes and try again.' }, { status: 429 })
  }
  const body = (await req.json().catch(() => ({}))) as { action?: string; address?: string; issuedAt?: number; signature?: string }
  // Before asking for a signature: does this wallet already have an account? (Onboarding
  // already reveals this through its "wallet_linked" answer, so it leaks nothing new.)
  if (body.action === 'check') {
    if (!body.address || !isAddress(body.address)) return NextResponse.json({ error: 'That does not look like a wallet address.' }, { status: 400 })
    const address = getAddress(body.address)
    const mock = serverConfig().chain.mode === 'mock'
    const root = mock ? null : await whitelistedRoot(address).catch(() => null)
    const exists = Boolean((await accountForWallet(address)) ?? (root ? await accountForWallet(root) : null))
    return NextResponse.json({ exists })
  }
  if (!body.address || !isAddress(body.address) || !body.signature || !isHex(body.signature) || typeof body.issuedAt !== 'number') {
    return NextResponse.json({ error: 'Missing signature.' }, { status: 400 })
  }
  if (Math.abs(Date.now() - body.issuedAt) > WINDOW_MS) return NextResponse.json({ error: 'That sign-in expired. Try again.' }, { status: 400 })
  const address = getAddress(body.address)

  const client = createPublicClient({ chain: celo, transport: http(serverConfig().chain.rpcUrl) })
  // verifyMessage also handles smart-contract wallets (ERC-1271).
  const valid = await client
    .verifyMessage({ address, message: walletLoginMessage(address, body.issuedAt), signature: body.signature })
    .catch(() => false)
  if (!valid) return NextResponse.json({ error: 'That signature didn’t match this wallet.' }, { status: 401 })

  // Each signature signs in once.
  await run('CREATE TABLE IF NOT EXISTS wallet_logins (signature TEXT PRIMARY KEY, created_at INTEGER NOT NULL)')
  const used = await run('INSERT OR IGNORE INTO wallet_logins (signature, created_at) VALUES (?, ?)', [body.signature.toLowerCase(), Date.now()])
  if (!used.rowsAffected) return NextResponse.json({ error: 'That sign-in was already used. Try again.' }, { status: 400 })

  const root = (await whitelistedRoot(address).catch(() => null)) ?? address
  const userId = (await accountForWallet(address)) ?? (await accountForWallet(root))
  const user = userId ? await getUserById(userId) : null
  if (!user) return NextResponse.json({ error: 'No Jara account uses this wallet yet.' }, { status: 404 })

  const res = NextResponse.json(await userState(user))
  setSessionCookie(res, user.sessionToken)
  return res
}
