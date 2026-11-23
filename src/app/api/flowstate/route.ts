import { NextRequest, NextResponse } from 'next/server'
import { isAddress, verifyMessage } from 'viem'
import { FLOW_CHAIN, FLOW_COUNCIL, FLOW_QUERY, PROJECT_NAME, PROJECT_RECIPIENT, flowClaimMessage, normalizeName } from '@/lib/flowstate'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

const BASE = 'https://flowstate.network/api/flow-council'
const reply = (body: unknown, status = 200) => NextResponse.json(body, { status, headers: { 'Cache-Control': 'no-store' } })

async function upstream(path: string, init?: RequestInit) {
  const response = await fetch(`${BASE}/${path}`, { ...init, cache: 'no-store', signal: AbortSignal.timeout(15_000), redirect: 'error' })
  const data = await response.json().catch(() => null)
  if (!data || typeof data !== 'object') throw new Error('Flowstate returned an incomplete response. Please retry.')
  return { response, data }
}

type Recipient = { address?: unknown; name?: unknown }

/** Council details: Jara's listing (checked by name) and the community vote size. */
export async function GET() {
  try {
    const [recipients, groups] = await Promise.all([
      upstream(`recipients?${FLOW_QUERY}`),
      upstream(`voter-groups/public?${FLOW_QUERY}&includeMembers=0`),
    ])
    if (!recipients.response.ok || !groups.response.ok || !Array.isArray(recipients.data.recipients) || !Array.isArray(groups.data.groups))
      throw new Error('Flowstate voting details are unavailable.')
    const list = recipients.data.recipients as Recipient[]
    if (list.length > 1000 || list.some((r) => typeof r.address !== 'string' || !isAddress(r.address) || (r.name !== null && typeof r.name !== 'string')))
      throw new Error('Flowstate returned invalid recipient details.')
    const valid = list as { address: string; name: string | null }[]
    const target = valid.find((r) => r.address.toLowerCase() === PROJECT_RECIPIENT)
    if (!target || normalizeName(target.name ?? '') !== normalizeName(PROJECT_NAME))
      return reply({ error: `${PROJECT_NAME} is not listed for voting in this council right now.` }, 503)
    const community = (groups.data.groups as { eligibilityMethod?: unknown; defaultVotingPower?: unknown }[]).find((g) => g.eligibilityMethod === 'gooddollar')
    if (!community || !Number.isSafeInteger(community.defaultVotingPower) || (community.defaultVotingPower as number) <= 0)
      return reply({ error: 'GoodDollar community voting is unavailable right now.' }, 503)
    return reply({
      communityVotes: community.defaultVotingPower,
      recipients: valid.map((r) => ({ address: r.address.toLowerCase(), name: r.name?.slice(0, 120) ?? null })),
    })
  } catch {
    return reply({ error: 'Couldn’t load Flowstate voting details. Please retry.' }, 503)
  }
}

/** Relays the person's own council-bound claim signature to Flowstate. No
 * signer, treasury key, credential or general-purpose proxy is involved. */
export async function POST(req: NextRequest) {
  const origin = req.headers.get('origin')
  // Same-origin only, plus a custom header a cross-site form cannot send.
  if (req.headers.get('x-flow-vote') !== '1' || (origin && origin !== req.nextUrl.origin))
    return reply({ error: 'Requests must come from this site.' }, 403)
  try {
    const reader = req.body?.getReader()
    const decoder = new TextDecoder()
    let text = ''
    let size = 0
    if (reader)
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        size += value.byteLength
        if (size > 2048) {
          await reader.cancel()
          return reply({ error: 'Request is too large.' }, 413)
        }
        text += decoder.decode(value, { stream: true })
      }
    text += decoder.decode()
    let body: { address?: unknown; issuedAt?: unknown; signature?: unknown } | null
    try {
      body = JSON.parse(text)
    } catch {
      return reply({ error: 'Invalid request.' }, 400)
    }
    const { address, issuedAt, signature } = body ?? {}
    if (
      typeof address !== 'string' || !isAddress(address) ||
      typeof issuedAt !== 'number' || !Number.isSafeInteger(issuedAt) || Math.abs(Date.now() - issuedAt) > 180_000 ||
      typeof signature !== 'string' || !/^0x[0-9a-fA-F]{130}$/.test(signature)
    )
      return reply({ error: 'Voting-rights proof is invalid or expired. Please try again.' }, 400)
    // Web3Auth and injected EOAs sign this message. Contract wallets should use
    // Flowstate's own interface rather than being misidentified here.
    if (!(await verifyMessage({ address, message: flowClaimMessage(address, issuedAt), signature: signature as `0x${string}` })))
      return reply({ error: 'The signature does not match this wallet.' }, 401)
    const { response, data } = await upstream('eligibility', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ address, issuedAt, signature, chainId: FLOW_CHAIN, councilId: FLOW_COUNCIL }),
    })
    if (response.ok && data.success === true) return reply({ ok: true })
    if (data.alreadyClaimed)
      return reply({ error: 'This GoodDollar identity has voting rights on another wallet. Use that wallet on Flowstate.', code: 'IDENTITY_ALREADY_CLAIMED' }, 409)
    if (data.notWhitelisted)
      return reply({ error: 'GoodDollar verification is not valid for this wallet. Renew it, then retry.', code: 'VERIFICATION_REQUIRED' }, 403)
    if (data.reason === 'expired_signature') return reply({ error: 'The signature expired. Claim voting rights again.' }, 400)
    return reply({ error: 'Flowstate couldn’t grant voting rights right now. Refresh your status before retrying.' }, response.status === 429 ? 429 : 503)
  } catch {
    return reply({ error: 'The eligibility response was interrupted. Refresh your status before retrying.' }, 503)
  }
}
