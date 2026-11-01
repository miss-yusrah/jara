import { NextResponse } from 'next/server'
import { timingSafeEqual } from 'node:crypto'
import { addTopup, deleteTopup, treasuryReport } from '@/lib/treasury'

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
