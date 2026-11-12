import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'
import { DISCO_INFO, type Disco, type MeterType, type Network } from '@/lib/catalog'
import { serverConfig } from '@/lib/env'
import type { DataPlan, MeterVerification, TopupProvider, TopupResult } from './types'

// FalconPay bills API — https://business.falconpay.ng/developer/docs
//   GET  /api/bills/services?product=…       billers for a product
//   GET  /api/bills/variations?product=&service_id=   data bundles, meter types
//   POST /api/bills/verify                    meter → customer name
//   GET  /api/bills/quote?…                   price + short-lived signed quote_token
//   POST /api/bills/pay                       buy it (200 done/accepted, 202 in flight, 422 declined+refunded)
//   GET  /api/bills/status?reference=…        authoritative status; settled:false = not yet known
// Auth: x-api-key: sk_test_… (sandbox) or sk_live_… (production).

type Product = 'airtime' | 'data' | 'electricity'

interface FalconResponse<T = Record<string, unknown>> {
  success?: boolean
  message?: string
  error?: string
  data?: T
}

interface Service {
  service_id: string
  name: string
  min?: string
  max?: string
}

interface Variation {
  variation_code: string
  name: string
  amount: string
  is_fixed?: number
}

interface BillData {
  reference?: string
  transaction_reference?: string
  status?: string
  settled?: boolean
  token?: string | null
  units?: string | null
}

const CACHE_MS = 30 * 60_000

// How each of our networks / discos shows up in FalconPay biller names and ids.
const NETWORK_MATCH: Record<Network, RegExp> = {
  mtn: /\bmtn\b/i,
  airtel: /\bairtel\b/i,
  glo: /\bglo\b/i,
  '9mobile': /9mobile|etisalat|t2/i,
}
const DISCO_MATCH: Record<Disco, RegExp> = {
  ikeja: /ikeja|ikedc/i,
  eko: /\beko\b|ekedc/i,
  abuja: /abuja|aedc/i,
  ibadan: /ibadan|ibedc/i,
  enugu: /enugu|eedc/i,
  portharcourt: /port\s*-?harcourt|phed|phedc/i,
  benin: /benin|bedc/i,
  kano: /kano|kedco/i,
  kaduna: /kaduna|kaedco/i,
  jos: /\bjos\b|jed\b|jedc/i,
  aba: /\baba\b|abedc|aba power/i,
  yola: /yola|yedc/i,
}

/** Bill statuses FalconPay uses for a delivered or a declined purchase. */
const DONE = /^(completed|successful|success|delivered)$/i
const FAILED = /^(failed|declined|reversed|refunded|cancelled)$/i

export class FalconPayProvider implements TopupProvider {
  readonly name = 'falconpay'
  private services = new Map<Product, { list: Service[]; at: number }>()
  private variations = new Map<string, { list: Variation[]; at: number }>()

  private get config() {
    return serverConfig().falconpay
  }

  createReference(): string {
    return `JARA-${Date.now()}-${randomBytes(5).toString('hex')}`
  }

  // ---------- catalog ----------

  private async listServices(product: Product): Promise<Service[]> {
    const hit = this.services.get(product)
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.list
    const { status, json } = await this.request<Service[]>('GET', `/api/bills/services?product=${product}`)
    if (status !== 200 || !Array.isArray(json.data)) throw new Error(`FalconPay services(${product}) HTTP ${status}: ${json.message ?? ''}`)
    this.services.set(product, { list: json.data, at: Date.now() })
    return json.data
  }

  private async serviceId(product: Product, match: RegExp, label: string): Promise<string> {
    const list = await this.listServices(product)
    const found = list.find((s) => match.test(s.service_id) || match.test(s.name))
    if (!found) throw new Error(`FalconPay has no ${product} biller for ${label}`)
    return found.service_id
  }

  private async listVariations(product: Product, serviceId: string): Promise<Variation[]> {
    const key = `${product}:${serviceId}`
    const hit = this.variations.get(key)
    if (hit && Date.now() - hit.at < CACHE_MS) return hit.list
    const { status, json } = await this.request<{ variations?: Variation[] }>(
      'GET',
      `/api/bills/variations?product=${product}&service_id=${encodeURIComponent(serviceId)}`,
    )
    if (status !== 200) throw new Error(`FalconPay variations(${serviceId}) HTTP ${status}: ${json.message ?? ''}`)
    const list = json.data?.variations ?? []
    this.variations.set(key, { list, at: Date.now() })
    return list
  }

  /** The variation code FalconPay uses for a prepaid/postpaid meter on this disco. */
  private async meterVariation(serviceId: string, meterType: MeterType): Promise<string> {
    const list = await this.listVariations('electricity', serviceId).catch(() => [] as Variation[])
    const found = list.find((v) => new RegExp(meterType, 'i').test(v.variation_code) || new RegExp(meterType, 'i').test(v.name))
    return found?.variation_code ?? meterType
  }

  async listDataPlans(network: Network): Promise<DataPlan[]> {
    const serviceId = await this.serviceId('data', NETWORK_MATCH[network], network)
    return (await this.listVariations('data', serviceId))
      .map((v) => ({ code: v.variation_code, name: v.name, amountNgn: Number(v.amount) }))
      .filter((p) => Number.isFinite(p.amountNgn) && p.amountNgn > 0)
      .sort((a, b) => a.amountNgn - b.amountNgn)
  }

  async verifyMeter({ disco, meterType, meterNumber }: { disco: Disco; meterType: MeterType; meterNumber: string }): Promise<MeterVerification> {
    const serviceId = await this.serviceId('electricity', DISCO_MATCH[disco], DISCO_INFO[disco].short)
    const { status, json } = await this.request<Record<string, string>>('POST', '/api/bills/verify', {
      product: 'electricity',
      service_id: serviceId,
      customer_id: meterNumber,
      variation_code: await this.meterVariation(serviceId, meterType),
    })
    const name = json.data?.Customer_Name ?? json.data?.customer_name ?? json.data?.name
    if (status === 200 && name) return { valid: true, customerName: name, address: json.data?.Address ?? json.data?.address ?? undefined }
    if (status === 404 || status === 400 || status === 422 || (status === 200 && !name)) {
      return { valid: false, message: json.message || 'Meter number not found for this electricity company and meter type.' }
    }
    throw new Error(`FalconPay verify HTTP ${status}: ${json.message ?? ''}`)
  }

  // ---------- purchases ----------

  async buyAirtime({ network, phone, amount, reference }: Parameters<TopupProvider['buyAirtime']>[0]) {
    return this.buy(reference, { product: 'airtime', serviceId: () => this.serviceId('airtime', NETWORK_MATCH[network], network), amount, customerId: phone })
  }

  async buyData({ network, phone, planCode, amount, reference }: Parameters<TopupProvider['buyData']>[0]) {
    return this.buy(reference, { product: 'data', serviceId: () => this.serviceId('data', NETWORK_MATCH[network], network), amount, customerId: phone, variationCode: planCode })
  }

  async buyElectricity({ disco, meterType, meterNumber, phone, amount, reference }: Parameters<TopupProvider['buyElectricity']>[0]) {
    let serviceId = ''
    return this.buy(reference, {
      product: 'electricity',
      serviceId: async () => (serviceId = await this.serviceId('electricity', DISCO_MATCH[disco], DISCO_INFO[disco].short)),
      variationCode: async () => this.meterVariation(serviceId, meterType),
      amount,
      customerId: meterNumber,
      phone,
    })
  }

  /** Quote, then pay. Anything that fails before /bills/pay is sent spent nothing, so it's a clean failure. */
  private async buy(
    reference: string,
    input: {
      product: Product
      serviceId: () => Promise<string>
      amount: number
      customerId: string
      variationCode?: string | (() => Promise<string>)
      phone?: string
    },
  ): Promise<TopupResult> {
    let body: Record<string, unknown>
    try {
      const serviceId = await input.serviceId()
      const variationCode = typeof input.variationCode === 'function' ? await input.variationCode() : input.variationCode
      const q = new URLSearchParams({ product: input.product, service_id: serviceId, amount: String(input.amount) })
      if (variationCode) q.set('variation_code', variationCode)
      const quote = await this.request<{ face_amount: number; amount_to_be_debited: number; quote_token: string; quote_exp: number }>('GET', `/api/bills/quote?${q}`)
      if (quote.status !== 200 || !quote.json.data?.quote_token) {
        return { state: 'failed', reference, message: quote.json.message || 'Could not price this purchase' }
      }
      const qd = quote.json.data
      body = {
        reference,
        product: input.product,
        service_id: serviceId,
        amount: qd.face_amount,
        customer_id: input.customerId,
        face_amount: qd.face_amount,
        net_amount: qd.amount_to_be_debited,
        quote_exp: qd.quote_exp,
        quote_token: qd.quote_token,
        ...(variationCode ? { variation_code: variationCode } : {}),
        ...(input.phone ? { phone: input.phone } : {}),
      }
    } catch (err) {
      return { state: 'failed', reference, message: err instanceof Error ? err.message : 'FalconPay unavailable' }
    }

    let res: { status: number; json: FalconResponse<BillData> }
    try {
      // A slow provider remains pending under this reference; status checks and
      // webhooks finish it without holding the browser open for a full minute.
      res = await this.request<BillData>('POST', '/api/bills/pay', body, 15_000)
    } catch (err) {
      // Timeout or transport error after sending: it may still go through. Check status later.
      console.error('[falconpay] /bills/pay transport error', reference, err)
      return { state: 'pending', reference, message: 'No response from FalconPay yet' }
    }
    return interpretPay(res.status, res.json, reference)
  }

  async getStatus(reference: string): Promise<TopupResult> {
    const { status, json } = await this.request<BillData>('GET', `/api/bills/status?reference=${encodeURIComponent(reference)}`, undefined, 20_000)
    if (status === 404) return { state: 'not_found', reference, message: json.message }
    if (status !== 200 || !json.data) return { state: 'pending', reference, message: json.message }
    const d = json.data
    const base = resultBase(d, reference, json.message)
    if (d.settled === false || (d.reference && d.reference !== reference)) return { ...base, state: 'pending' }
    if (d.status && FAILED.test(d.status)) return { ...base, state: 'failed' }
    if (d.status && DONE.test(d.status)) return { ...base, state: 'success' }
    return { ...base, state: 'pending' }
  }

  // ---------- transport ----------

  private async request<T>(method: 'GET' | 'POST', path: string, body?: unknown, timeoutMs = 20_000): Promise<{ status: number; json: FalconResponse<T> }> {
    const { baseUrl, apiKey } = this.config
    if (!apiKey) throw new Error('FALCONPAY_API_KEY is not set')
    const res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: { 'x-api-key': apiKey, 'content-type': 'application/json', accept: 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
      cache: 'no-store',
      signal: AbortSignal.timeout(timeoutMs),
    })
    const text = await res.text()
    let json: FalconResponse<T> = {}
    try {
      json = text ? (JSON.parse(text) as FalconResponse<T>) : {}
    } catch {
      json = { message: `Non-JSON response: ${text.slice(0, 160)}` }
    }
    return { status: res.status, json }
  }
}

function resultBase(d: BillData, reference: string, message?: string) {
  return {
    reference,
    providerTransactionId: d.transaction_reference,
    providerStatus: d.status,
    message,
    token: d.token ? String(d.token) : undefined,
    units: d.units ? `${d.units} kWh` : undefined,
  }
}

function interpretPay(status: number, json: FalconResponse<BillData>, reference: string): TopupResult {
  const d = json.data ?? {}
  const base = resultBase(d, reference, json.message ?? json.error)
  // A transport status is not proof that a submitted purchase did not deliver.
  // Unsettled/conflicting responses must be resolved through the saved reference.
  if (d.settled === false || (d.reference && d.reference !== reference)) return { ...base, state: 'pending' }
  if (status === 202 || status === 409) return { ...base, state: 'pending' }
  if (status === 200 || status === 422) {
    if (d.status && FAILED.test(d.status)) return { ...base, state: 'failed' }
    if (status === 200 && d.status && DONE.test(d.status)) return { ...base, state: 'success' }
  }
  return { ...base, state: 'pending' } // HTTP errors alone never authorize a refund.

}

/**
 * Verify a FalconPay webhook: HMAC-SHA256 over `${timestamp}.${rawBody}` with the
 * webhook secret, hex, in x-falconpay-signature (timestamp in x-falconpay-timestamp).
 * Also accepts the `t=…,v1=…` signature header format FalconPay uses for some events.
 */
export function verifyFalconWebhook(rawBody: string, headers: Headers): boolean {
  const secret = serverConfig().falconpay.webhookSecret
  const header = headers.get('x-falconpay-signature') ?? ''
  if (!secret || !header) return false
  let timestamp = headers.get('x-falconpay-timestamp') ?? ''
  let signature = header
  if (header.includes('v1=')) {
    const parts = Object.fromEntries(header.split(',').map((p) => p.trim().split('=') as [string, string]))
    timestamp = parts.t ?? timestamp
    signature = parts.v1 ?? ''
  }
  const n = Number(timestamp)
  const t = n > 1e12 ? n / 1000 : n // seconds or milliseconds
  if (!timestamp || !Number.isFinite(t) || Math.abs(Date.now() / 1000 - t) > 300) return false
  const expected = createHmac('sha256', secret).update(`${timestamp}.${rawBody}`).digest('hex')
  return signature.length === expected.length && timingSafeEqual(Buffer.from(signature), Buffer.from(expected))
}
