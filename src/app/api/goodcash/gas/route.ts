import { NextResponse, type NextRequest } from 'next/server'
import type { Address } from 'viem'
import { topUpFromFaucet } from '@/lib/chain'
import { serverConfig } from '@/lib/env'
import { rateLimit } from '@/lib/ratelimit'
import { fromThisSite } from '@/lib/same-site'
import { requireUser } from '@/lib/session'

export const dynamic = 'force-dynamic'

const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } })

/**
 * Before a GoodCash cash out: make sure the person's own verified wallet has a little CELO for the
 * network fee. It comes from GoodDollar's faucet (at most one top-up a day per wallet), and only ever
 * to this account's verified wallet.
 */
export async function POST(req: NextRequest) {
  if (req.headers.get('x-goodcash') !== '1' || !fromThisSite(req)) return reply({ error: 'Requests must come from this site.' }, 403)
  const user = await requireUser()
  if (user instanceof NextResponse) return user
  if (serverConfig().chain.mode !== 'celo' || !user.connected || !user.rootAddress) return reply({ ready: false })
  if (!rateLimit(`goodcash-gas:${user.id}`, 5, 10 * 60_000)) return reply({ error: 'Too many tries. Wait a few minutes.' }, 429)
  try {
    return reply({ ready: await topUpFromFaucet(user.rootAddress as Address) })
  } catch {
    // The wallet may still have enough CELO; let the cash out go ahead and the wallet decide.
    return reply({ ready: false })
  }
}
