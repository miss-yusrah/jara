import { NextResponse } from 'next/server'
import { handleGoodCashWebhook } from '@/lib/goodcash'

export const dynamic = 'force-dynamic'

// GoodCash signs every webhook (GoodCash-Signature over the raw body). Set this URL once per mode:
//   curl -X PUT https://api.goodcash.xyz/v1/webhooks -H "Authorization: Bearer $GOODCASH_SECRET_KEY" \
//     -H "Content-Type: application/json" -d '{"url":"https://usejara.xyz/api/goodcash/webhook"}'
// and store the returned whsec_ secret as GOODCASH_WEBHOOK_SECRET.
export async function POST(req: Request) {
  const { status, body } = await handleGoodCashWebhook(await req.text(), req.headers.get('goodcash-signature'))
  return NextResponse.json(body, { status })
}
