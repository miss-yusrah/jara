import { NextResponse } from 'next/server'
import { getAddress, isHex } from 'viem'
import { verifyWalletSignature } from '@/lib/chain'
import { run } from '@/lib/db'
import { serverConfig } from '@/lib/env'
import { clientIp, rateLimit } from '@/lib/ratelimit'
import { requireUser } from '@/lib/session'
import { getUserById, logActivity } from '@/lib/users'
import { walletKeyExportMessage } from '@/lib/wallet-login'
import { agentKey } from '@/lib/wallets'
import { bad } from '../../_shared'

export const dynamic = 'force-dynamic'

const WINDOW_MS = 5 * 60_000

// The Jara wallet belongs to the person, so they can always take its key. Being signed
// in is not enough to see it: the request must carry a fresh signature from the verified
// GoodDollar wallet the Jara wallet is linked to, and each signature works once.
export async function POST(req: Request) {
  const session = await requireUser()
  if (session instanceof NextResponse) return session
  if (serverConfig().chain.mode !== 'celo') return bad('Demo wallets hold simulated G$ and have no key to export.', 404)
  if (!rateLimit(`key-export:${session.id}`, 8, 60 * 60_000) || !rateLimit(`key-export-ip:${clientIp(req)}`, 24, 60 * 60_000)) {
    return NextResponse.json({ error: 'Too many tries. Wait a while and try again.' }, { status: 429 })
  }
  const user = (await getUserById(session.id))!
  if (user.agentKeyEnc === 'keyless') return bad('Your claim contract has no private key. Your own wallet controls it.', 404)
  if (!user.connected || !user.rootAddress) return bad('Connect your GoodDollar account first.')
  const body = (await req.json().catch(() => ({}))) as { issuedAt?: number; signature?: string }
  if (typeof body.issuedAt !== 'number' || !body.signature || !isHex(body.signature)) return bad('Missing signature.')
  if (Math.abs(Date.now() - body.issuedAt) > WINDOW_MS) return bad('That request expired. Try again.')

  const owner = getAddress(user.rootAddress)
  const message = walletKeyExportMessage(owner, user.agentAddress, body.issuedAt)
  if (!(await verifyWalletSignature(owner, message, body.signature))) {
    return NextResponse.json({ error: 'That signature is not from the GoodDollar wallet this Jara wallet belongs to.' }, { status: 401 })
  }
  const used = await run('INSERT OR IGNORE INTO key_exports (signature, user_id, created_at) VALUES (?, ?, ?)', [body.signature.toLowerCase(), user.id, Date.now()])
  if (!used.rowsAffected) return bad('That request was already used. Try again.')

  const privateKey = await agentKey(user)
  await logActivity(user.id, { type: 'agent', title: 'You viewed your Jara wallet key', detail: 'Shown after a signature from your GoodDollar wallet. If this wasn’t you, send your claimed G$ to your own wallet now.' })
  return NextResponse.json({ address: user.agentAddress, privateKey }, { headers: { 'cache-control': 'no-store' } })
}
