import { NextResponse } from 'next/server'
import { isDisco, isMeterType, normalizeMeterNumber, normalizePhone, detectNetwork, isNetwork } from '@/lib/catalog'
import { serverConfig } from '@/lib/env'
import { updateJar, type JarDetails } from '@/lib/jars'
import { getTopupProvider } from '@/lib/providers'
import { requireUser } from '@/lib/session'
import { getUserById, isJarKind } from '@/lib/users'
import { bad, userState } from '../_shared'

export const dynamic = 'force-dynamic'

export async function POST(req: Request) {
  const user = await requireUser()
  if (user instanceof NextResponse) return user
  const body = (await req.json().catch(() => ({}))) as {
    kind?: string
    targetNgn?: number
    autoPay?: boolean
    phone?: string
    network?: string
    disco?: string
    meterType?: string
    meterNumber?: string
    everyDays?: number | null
  }
  if (!isJarKind(body.kind)) return bad('Unknown jar')
  const details: JarDetails = {}
  const testNumbers = serverConfig().provider === 'mock' || serverConfig().vtpass.env === 'sandbox'

  if (body.phone !== undefined && body.phone !== '') {
    const phone = normalizePhone(body.phone, testNumbers)
    if (!phone) return bad('Phone number should look like 0803 123 4567.')
    details.phone = phone
    details.network = (isNetwork(body.network) ? body.network : detectNetwork(phone)) ?? undefined
  }
  if (body.kind === 'light' && body.meterNumber) {
    const meter = normalizeMeterNumber(body.meterNumber)
    const meterType = body.meterType ?? 'prepaid'
    if (!meter || !isDisco(body.disco) || !isMeterType(meterType)) return bad('Pick your electricity company and enter a valid meter number.')
    const check = await getTopupProvider().verifyMeter({ disco: body.disco, meterType, meterNumber: meter })
    if (!check.valid) return bad(check.message)
    Object.assign(details, { disco: body.disco, meterType, meterNumber: meter, customerName: check.customerName })
  }
  const target = typeof body.targetNgn === 'number' && Number.isFinite(body.targetNgn) ? Math.min(Math.max(body.targetNgn, 0), serverConfig().limits.maxBillNgn) : undefined
  const every = body.everyDays === null ? null : typeof body.everyDays === 'number' && body.everyDays > 0 ? Math.min(Math.round(body.everyDays), 60) : undefined
  await updateJar(user.id, body.kind, { targetNgn: target, autoPay: typeof body.autoPay === 'boolean' ? body.autoPay : undefined, details, ...(every !== undefined ? { everyDays: every } : {}) })
  return NextResponse.json(await userState((await getUserById(user.id))!))
}
