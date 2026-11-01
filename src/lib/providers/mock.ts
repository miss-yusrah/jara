import { randomBytes, randomInt } from 'node:crypto'
import type { Network } from '@/lib/catalog'
import type { DataPlan, MeterVerification, TopupProvider, TopupResult } from './types'

// Local development provider. Mirrors the VTpass sandbox test numbers:
//   201000000000 → pending, delivered 30s later
//   08000000000  → failed
//   anything else → delivered
// Meters: any meter is valid except 0000000000000.

const PENDING_MS = 30_000

interface MockTopup {
  phone: string
  createdAt: number
  token?: string
  units?: string
}

const globalForMock = globalThis as typeof globalThis & { __mockTopups?: Map<string, MockTopup> }
const topups = (globalForMock.__mockTopups ??= new Map())

function outcome(phone: string, createdAt: number): TopupResult['state'] {
  if (phone === '08000000000') return 'failed'
  if (phone === '201000000000') return Date.now() - createdAt < PENDING_MS ? 'pending' : 'success'
  return 'success'
}

function result(reference: string, state: TopupResult['state'], topup?: MockTopup): TopupResult {
  const messages = { success: 'Delivered (mock)', pending: 'Processing (mock)', failed: 'Failed (mock)', not_found: 'Unknown reference (mock)' }
  return {
    state,
    reference,
    providerTransactionId: `mock-${reference}`,
    providerStatus: state,
    message: messages[state],
    ...(state === 'success' ? { token: topup?.token, units: topup?.units } : {}),
  }
}

function record(reference: string, topup: MockTopup): TopupResult {
  topups.set(reference, topup)
  return result(reference, outcome(topup.phone, topup.createdAt), topup)
}

export class MockProvider implements TopupProvider {
  readonly name = 'mock'

  createReference(): string {
    return `mock${Date.now()}${randomBytes(4).toString('hex')}`
  }

  async buyAirtime({ phone, reference }: Parameters<TopupProvider['buyAirtime']>[0]) {
    return record(reference, { phone, createdAt: Date.now() })
  }

  async buyData({ phone, reference }: Parameters<TopupProvider['buyData']>[0]) {
    return record(reference, { phone, createdAt: Date.now() })
  }

  async buyElectricity({ meterType, phone, amount, reference }: Parameters<TopupProvider['buyElectricity']>[0]) {
    const prepaid = meterType === 'prepaid'
    return record(reference, {
      phone,
      createdAt: Date.now(),
      token: prepaid ? Array.from({ length: 20 }, () => randomInt(10)).join('') : undefined,
      units: prepaid ? `${(amount / 209.5).toFixed(1)} kWh` : undefined,
    })
  }

  async verifyMeter({ meterNumber }: Parameters<TopupProvider['verifyMeter']>[0]): Promise<MeterVerification> {
    if (/^0+$/.test(meterNumber)) return { valid: false, message: 'Meter number not found (mock).' }
    return { valid: true, customerName: 'ADA OKAFOR (DEMO)', address: '12 Admiralty Way, Lekki' }
  }

  async getStatus(reference: string) {
    const topup = topups.get(reference)
    return topup ? result(reference, outcome(topup.phone, topup.createdAt), topup) : result(reference, 'not_found')
  }

  async listDataPlans(network: Network): Promise<DataPlan[]> {
    return [
      { code: `${network}-mock-500mb`, name: '500MB – 1 day', amountNgn: 350 },
      { code: `${network}-mock-1gb`, name: '1GB – 7 days', amountNgn: 800 },
      { code: `${network}-mock-2gb`, name: '2GB – 30 days', amountNgn: 1500 },
    ]
  }
}
