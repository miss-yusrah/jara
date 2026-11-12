import { NextResponse } from 'next/server'
import { settlePendingBills } from '@/lib/bills'
import { verifyFalconWebhook } from '@/lib/providers/falconpay'

export const dynamic = 'force-dynamic'

// FalconPay calls this when a bill purchase finishes (bill.completed / bill.failed).
// The payload only tells us which reference to look at: we settle it from the
// authoritative /bills/status answer, never from the webhook body itself.
export async function POST(req: Request) {
  const raw = await req.text()
  if (!verifyFalconWebhook(raw, req.headers)) {
    console.warn('[falconpay webhook] rejected: bad or missing signature', {
      hasSignature: req.headers.has('x-falconpay-signature'),
      timestamp: req.headers.get('x-falconpay-timestamp'),
    })
    return NextResponse.json({ error: 'Bad signature' }, { status: 401 })
  }
  let reference: string | undefined
  try {
    const body = JSON.parse(raw) as { reference?: string; data?: { reference?: string } }
    reference = body.reference ?? body.data?.reference
  } catch {
    return NextResponse.json({ ok: true, ignored: 'not JSON' })
  }
  if (!reference || !reference.startsWith('JARA-')) return NextResponse.json({ ok: true, ignored: 'not a Jara bill' })
  try {
    const r = await settlePendingBills(reference)
    return NextResponse.json({ ok: true, ...r })
  } catch (err) {
    console.error('[falconpay webhook] settle failed', reference, err)
    // 200 anyway: the scheduled run re-checks every pending bill, so nothing is lost.
    return NextResponse.json({ ok: true, deferred: true })
  }
}
