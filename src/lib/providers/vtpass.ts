import { randomBytes } from 'node:crypto'
import type { Disco, Network } from '@/lib/catalog'
import { serverConfig } from '@/lib/env'
import type { DataPlan, MeterVerification, TopupProvider, TopupResult } from './types'

// https://www.vtpass.com/documentation/

const AIRTIME_SERVICE: Record<Network, string> = {
  mtn: 'mtn',
  airtel: 'airtel',
  glo: 'glo',
  '9mobile': 'etisalat',
}

const DATA_SERVICE: Record<Network, string> = {
  mtn: 'mtn-data',
  airtel: 'airtel-data',
  glo: 'glo-data',
  '9mobile': 'etisalat-data',
}

const ELECTRICITY_SERVICE = (disco: Disco) => `${disco}-electric`

// Codes meaning the purchase was rejected and nothing was delivered.
// https://www.vtpass.com/documentation/response-codes/
const REJECTED_CODES = new Set([
  '010', '011', '012', '013', '015', '016', '017', '018', '019', '021', '022', '023', '024',
  '025', '026', '027', '028', '030', '031', '032', '034', '035', '040', '085', '087', '091',
])

const PLAN_CACHE_MS = 10 * 60_000

interface VtpassResponse {
  code?: string
  response_description?: string
  message?: string
  requestId?: string
  // Electricity (top level on both /pay and /requery)
  purchased_code?: string
  token?: string
  mainToken?: string
  units?: string
  content?: {
    transactions?: { status?: string; transactionId?: string }
    variations?: { variation_code: string; name: string; variation_amount: string; fixedPrice?: string }[]
    // merchant-verify
    Customer_Name?: string
    Address?: string
    WrongBillersCode?: boolean
    error?: string
  }
}

/** VTpass requires request_id to start with YYYYMMDDHHII in Africa/Lagos time. */
function lagosTimestamp(date = new Date()): string {
  const parts = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Africa/Lagos',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).formatToParts(date)
  const part = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)?.value ?? ''
  return `${part('year')}${part('month')}${part('day')}${part('hour')}${part('minute')}`
}

function interpret(json: VtpassResponse, reference: string, isRequery: boolean): TopupResult {
  const code = json.code ?? ''
  const status = json.content?.transactions?.status?.toLowerCase()
  const base = {
    reference,
    providerTransactionId: json.content?.transactions?.transactionId,
    providerStatus: status,
    message: json.response_description ?? json.message ?? (code ? `VTpass code ${code}` : undefined),
    token: (json.token ?? json.purchased_code ?? json.mainToken)?.replace(/^\s*token\s*:\s*/i, '').trim() || undefined,
    units: json.units,
  }

  if (status === 'delivered') return { ...base, state: 'success' }
  // Requery responses can omit content.transactions entirely.
  if (!status && code === '000' && /success/i.test(json.response_description ?? '')) return { ...base, state: 'success' }
  if (status === 'failed' || status === 'reversed') return { ...base, state: 'failed' }

  if (isRequery) {
    if (code === '015') return { ...base, state: 'not_found' }
    // Anything else on a requery (including our own credential errors) says
    // nothing about the order, so keep checking.
    return { ...base, state: 'pending' }
  }

  // 014 = request_id already used: an earlier attempt exists, so find out what happened to it.
  if (code !== '014' && REJECTED_CODES.has(code)) return { ...base, state: 'failed' }
  return { ...base, state: 'pending' }
}

export class VTPassProvider implements TopupProvider {
  readonly name = 'vtpass'
  private planCache = new Map<Network, { plans: DataPlan[]; fetchedAt: number }>()

  private get config() {
    return serverConfig().vtpass
  }

  createReference(): string {
    return `${lagosTimestamp()}${randomBytes(6).toString('hex')}`
  }

  buyAirtime({ network, phone, amount, reference }: Parameters<TopupProvider['buyAirtime']>[0]) {
    return this.pay(reference, { serviceID: AIRTIME_SERVICE[network], amount, phone })
  }

  buyData({ network, phone, planCode, amount, reference }: Parameters<TopupProvider['buyData']>[0]) {
    return this.pay(reference, {
      serviceID: DATA_SERVICE[network],
      billersCode: phone,
      variation_code: planCode,
      amount,
      phone,
    })
  }

  buyElectricity({ disco, meterType, meterNumber, phone, amount, reference }: Parameters<TopupProvider['buyElectricity']>[0]) {
    return this.pay(reference, {
      serviceID: ELECTRICITY_SERVICE(disco),
      billersCode: meterNumber,
      variation_code: meterType,
      amount,
      phone,
    })
  }

  async verifyMeter({ disco, meterType, meterNumber }: Parameters<TopupProvider['verifyMeter']>[0]): Promise<MeterVerification> {
    const json = await this.post(
      '/merchant-verify',
      { billersCode: meterNumber, serviceID: ELECTRICITY_SERVICE(disco), type: meterType },
      20_000,
    )
    const content = json.content
    if (json.code === '000' && content && !content.WrongBillersCode && !content.error && content.Customer_Name) {
      return { valid: true, customerName: content.Customer_Name, address: content.Address || undefined }
    }
    if (json.code === '000' || json.code === '011' || json.code === '012') {
      return { valid: false, message: content?.error || 'Meter number not found for this provider and meter type.' }
    }
    throw new Error(`VTpass merchant-verify failed: ${json.code} ${json.response_description ?? json.message ?? ''}`)
  }

  async getStatus(reference: string): Promise<TopupResult> {
    const json = await this.post('/requery', { request_id: reference }, 20_000)
    return interpret(json, reference, true)
  }

  async listDataPlans(network: Network): Promise<DataPlan[]> {
    const cached = this.planCache.get(network)
    if (cached && Date.now() - cached.fetchedAt < PLAN_CACHE_MS) return cached.plans

    const { baseUrl, apiKey, publicKey } = this.config
    const res = await fetch(`${baseUrl}/service-variations?serviceID=${DATA_SERVICE[network]}`, {
      headers: { 'api-key': apiKey, 'public-key': publicKey },
      cache: 'no-store',
      signal: AbortSignal.timeout(15_000),
    })
    if (!res.ok) throw new Error(`VTpass service-variations HTTP ${res.status}`)
    const json = (await res.json()) as VtpassResponse
    const plans = (json.content?.variations ?? [])
      .map((v) => ({ code: v.variation_code, name: v.name, amountNgn: Number(v.variation_amount) }))
      .filter((plan) => Number.isFinite(plan.amountNgn) && plan.amountNgn > 0)
      .sort((a, b) => a.amountNgn - b.amountNgn)
    this.planCache.set(network, { plans, fetchedAt: Date.now() })
    return plans
  }

  private async pay(reference: string, body: Record<string, unknown>): Promise<TopupResult> {
    let json: VtpassResponse
    try {
      json = await this.post('/pay', { request_id: reference, ...body }, 60_000)
    } catch (err) {
      // Timeout or transport error: VTpass may still have processed it.
      console.error('VTpass /pay transport error', reference, err)
      return { state: 'pending', reference, message: 'No response from VTpass yet' }
    }
    return interpret(json, reference, false)
  }

  private async post(path: string, body: Record<string, unknown>, timeoutMs: number): Promise<VtpassResponse> {
    const { baseUrl, apiKey, secretKey } = this.config
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'api-key': apiKey, 'secret-key': secretKey, 'content-type': 'application/json' },
      body: JSON.stringify(body),
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await res.text()
    let parsed: unknown
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error(`VTpass ${path} returned non-JSON (HTTP ${res.status}): ${text.slice(0, 200)}`)
    }
    if (parsed && typeof parsed === 'object') return parsed as VtpassResponse
    // Missing keys come back as HTTP 401 with a bare JSON string.
    return { code: res.status === 401 ? '087' : undefined, message: String(parsed) }
  }
}
