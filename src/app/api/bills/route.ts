import { withUserLock } from '@/lib/jars'
import { apiFailure } from '@/lib/api-error'
import { NextResponse } from 'next/server'
import { formatEther } from 'viem'
import { resolvePending } from '@/lib/agent'
import { cancelPendingApprovals } from '@/lib/agent/approvals'
import { describeAction, prepareBill } from '@/lib/bills'
import { isNetwork } from '@/lib/catalog'
import { serverConfig } from '@/lib/env'
import { getTopupProvider } from '@/lib/providers'
import { clientIp, rateLimit } from '@/lib/ratelimit'
import { requireUser } from '@/lib/session'
import { getUserById, isBillKind, updateUser } from '@/lib/users'
import { bad, userState } from '../_shared'

export const dynamic = 'force-dynamic'

// The "Pay a bill" screen. Same rules as paying through chat: prepare → show the
// user exactly what it costs in G$ → pay only after they confirm.

/** Data plans for a network. */
export async function GET(req: Request) {
  const user = await requireUser()
  if (user instanceof NextResponse) return user
  const network = new URL(req.url).searchParams.get('network')
  if (!isNetwork(network)) return bad('Pick a network')
  try {
    const plans = await getTopupProvider().listDataPlans(network)
    return NextResponse.json({ plans: plans.filter((p) => p.amountNgn <= serverConfig().limits.maxBillNgn) })
  } catch (err) {
    console.error('[bills] plans failed', err)
    return bad('Could not load data plans right now. Try again shortly.', 502)
  }
}

export async function POST(req: Request) {
  try { return await post(req) } catch (err) { return apiFailure(err, 'bills') }
}

async function post(req: Request) {
  const user = await requireUser()
  if (user instanceof NextResponse) return user
  if (!rateLimit(`bills:${user.id}`, 20, 10 * 60_000) || !rateLimit(`bills-ip:${clientIp(req)}`, 60, 10 * 60_000)) {
    return NextResponse.json({ error: 'Too many tries — wait a few minutes.' }, { status: 429 })
  }
  if (!user.connected) return bad('Connect your GoodDollar account first.')
  const body = (await req.json().catch(() => null)) as {
    response?: string
    actionId?: string
    action?: 'prepare' | 'confirm' | 'cancel'
    kind?: string
    amountNgn?: number
    phone?: string
    network?: string
    planCode?: string
  } | null
  if (!body || typeof body !== 'object' || Array.isArray(body)) return bad('Invalid bill request.')

  if (body.action === 'confirm' || body.action === 'cancel') {
    if (!body.actionId) return bad('Review this bill again before confirming.')
    const reply = await resolvePending(user.id, body.action === 'confirm', body.actionId)
    if (body.response === 'compact') return NextResponse.json({ reply })
    return NextResponse.json({ reply, state: await userState((await getUserById(user.id))!) })
  }

  if (body.action !== 'prepare' || !isBillKind(body.kind)) return bad('Unknown request')
  const kind = body.kind
  return withUserLock(user.id, async () => {
    const fresh = (await getUserById(user.id))!
    if (fresh.pending?.id) {
      const { run } = await import('@/lib/db')
      const active = (await run('SELECT result FROM money_requests WHERE id = ?', [`${user.id}:bill:${fresh.pending.id}`])).rows[0]
      if (active && !active.result) return bad('Your previous bill is still processing. Wait for its result before starting another.')
    }
    const prepared = await prepareBill(user, {
      kind,
      amountNgn: Number(body.amountNgn ?? (body.kind === 'data' ? serverConfig().limits.maxBillNgn : 0)),
      phone: body.phone || undefined,
      network: isNetwork(body.network) ? body.network : undefined,
      planCode: body.planCode || undefined,
    })
    if ('error' in prepared) return bad(prepared.error)
    // One thing waits for a yes at a time: this bill replaces any assistant request.
    await cancelPendingApprovals(user.id)
    await updateUser(user.id, { pending: prepared.action })
    const gd = Math.ceil(Number(formatEther(BigInt(prepared.action.quoteWei!))))
    return NextResponse.json({ id: prepared.action.id, summary: describeAction(prepared.action), amountNgn: prepared.action.amountNgn, gd })
  })
}
