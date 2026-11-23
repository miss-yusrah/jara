import { NextRequest, NextResponse } from 'next/server'
import { fromThisSite } from '@/lib/same-site'
import { createPublicClient, encodeFunctionData, http, type Address } from 'viem'
import { celo } from 'viem/chains'
import { sponsorWalletCall } from '@/lib/chain'
import { run } from '@/lib/db'
import { serverConfig } from '@/lib/env'
import { FLOW_ABI, FLOW_COUNCIL, buildFlowVote, readFlowSnapshot } from '@/lib/flowstate'
import { withUserLock } from '@/lib/jars'
import { rateLimit } from '@/lib/ratelimit'
import { requireUser } from '@/lib/session'
import { apiFailure } from '@/lib/api-error'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

/** Treasury top-ups per Jara account for this council. Each covers one vote with
 * room to spare, and leftover CELO stays put, so later changes rarely need more. */
const MAX_SPONSORED = 3
const celoClient = () => createPublicClient({ chain: celo, transport: http(serverConfig().chain.rpcUrl) })
const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } })

/**
 * Jara covers the CELO fee for a vote for Jara. The council counts msg.sender,
 * so the person still sends the vote themselves; this tops up their own verified
 * wallet just enough for that exact ballot. Never sends to any other address.
 */
export async function POST(req: NextRequest) {
  if (req.headers.get('x-flow-vote') !== '1' || !fromThisSite(req))
    return reply({ error: 'Requests must come from this site.' }, 403)
  const user = await requireUser()
  if (user instanceof NextResponse) return user
  if (serverConfig().chain.mode !== 'celo') return reply({ error: 'Votes aren’t sponsored in this preview.' }, 400)
  if (!user.connected || !user.rootAddress) return reply({ error: 'Connect your GoodDollar account first.' }, 400)
  if (!rateLimit(`flow-gas:${user.id}`, 6, 10 * 60_000)) return reply({ error: 'Too many tries. Wait a few minutes and try again.' }, 429)
  const body = (await req.json().catch(() => null)) as { amount?: unknown } | null
  if (typeof body?.amount !== 'string') return reply({ error: 'Invalid request.' }, 400)
  const amount = body.amount
  const root = user.rootAddress.toLowerCase() as Address

  try {
    return await withUserLock(user.id, async () => {
      const client = celoClient()
      const snapshot = await readFlowSnapshot(client, root)
      let votes
      try {
        // Same rules as the card: verified root, claimed rights, a valid change for Jara.
        votes = buildFlowVote(snapshot, amount)
      } catch (err) {
        return reply({ error: err instanceof Error ? err.message : 'This vote can’t be sponsored.' }, 400)
      }
      const data = encodeFunctionData({ abi: FLOW_ABI, functionName: 'vote', args: [votes] })
      const prefix = `gas:flow-vote:${FLOW_COUNCIL}:${user.id}:`
      const used = Number((await run('SELECT COUNT(*) AS n FROM chain_transactions WHERE substr(id, 1, ?) = ?', [prefix.length, prefix])).rows[0]?.n ?? 0)
      // A top-up still settling is reused under its own id, never duplicated.
      const unsettled = (await run("SELECT id FROM chain_transactions WHERE substr(id, 1, ?) = ? AND status = 'pending' LIMIT 1", [prefix.length, prefix])).rows[0]
      const operationId = unsettled ? String(unsettled.id).slice(4) : `flow-vote:${FLOW_COUNCIL}:${user.id}:${used + 1}`
      if (!unsettled && used >= MAX_SPONSORED) {
        // Over the cap: only refuse if the wallet actually can't pay.
        if (await canPayVote(root, data, client)) return reply({ sponsored: false })
        return reply({ error: 'Jara has already covered your voting fees. Add a little CELO to this wallet to change your vote again.', code: 'sponsor_limit' }, 409)
      }
      const sponsored = await sponsorWalletCall(root, { to: FLOW_COUNCIL, data }, operationId)
      return reply({ sponsored })
    })
  } catch (err) {
    if (err instanceof Error && /network fees are unusually high/.test(err.message)) return reply({ error: err.message }, 503)
    return apiFailure(err, 'flowstate-gas')
  }
}

/** True if the wallet can already pay for this vote without any top-up. */
async function canPayVote(root: Address, data: `0x${string}`, client: ReturnType<typeof celoClient>) {
  const [gas, fees, balance] = await Promise.all([
    client.estimateGas({ account: root, to: FLOW_COUNCIL, data }),
    client.estimateFeesPerGas(),
    client.getBalance({ address: root }),
  ])
  return balance >= gas * (fees.maxFeePerGas ?? fees.gasPrice ?? 0n) * 2n
}
