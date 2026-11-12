import { NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { serverConfig } from '@/lib/env'
import { addTopup, deleteTopup, treasuryReport } from '@/lib/treasury'
import { custodyStatus } from '@/lib/wallets'
import { referralBudgetStatus } from '@/lib/rewards'
import { run } from '@/lib/db'

export const dynamic = 'force-dynamic'

function authorized(req: Request): boolean {
  const key = process.env.ADMIN_KEY
  if (!key) return false
  const got = (req.headers.get('authorization') ?? '').replace(/^Bearer\s+/i, '')
  const a = Buffer.from(got)
  const b = Buffer.from(key)
  return a.length === b.length && timingSafeEqual(a, b)
}

const deny = () => NextResponse.json({ error: process.env.ADMIN_KEY ? 'Wrong admin key' : 'Set ADMIN_KEY on the server first' }, { status: 401 })

export async function GET(req: Request) {
  if (!authorized(req)) return deny()
  // ?custody=1: which key protects the agent wallet keys, and how many still await migration.
  if (new URL(req.url).searchParams.has('custody')) {
    const cfg = serverConfig()
    const counts = (await run("SELECT COUNT(*) AS accounts, SUM(claimer_active) AS active, SUM(CASE WHEN connected = 1 AND claimer_active = 0 THEN 1 ELSE 0 END) AS awaiting_upgrade, SUM(CASE WHEN agent_key_enc != 'keyless' THEN 1 ELSE 0 END) AS retained_keys FROM users")).rows[0]
    return NextResponse.json({ referralBudget: await referralBudgetStatus(), custody: await custodyStatus(), keyless: { factory: cfg.chain.claimerFactory || null, spendingContract: cfg.chain.spendingContract || null, ...counts }, money: { mode: cfg.moneyMode, problem: cfg.moneyProblem, chain: cfg.chain.mode, provider: cfg.provider, billsLive: cfg.billsLive } })
  }
  return NextResponse.json(await treasuryReport())
}

// { amountUsd, note } adds a top-up; { deleteId } removes one.
export async function POST(req: Request) {
  if (!authorized(req)) return deny()
  const body = (await req.json().catch(() => ({}))) as { amountUsd?: number; note?: string; deleteId?: number }
  try {
    if (body.deleteId) await deleteTopup(Number(body.deleteId))
    else await addTopup(Number(body.amountUsd), body.note)
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Bad request' }, { status: 400 })
  }
  return NextResponse.json(await treasuryReport())
}
