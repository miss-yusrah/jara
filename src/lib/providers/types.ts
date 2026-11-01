import type { Disco, MeterType, Network } from '@/lib/catalog'

/**
 * - success:   delivered to the recipient
 * - pending:   accepted or outcome unknown — keep re-checking, never refund yet
 * - failed:    provider confirms nothing was delivered — safe to refund
 * - not_found: provider has no record of the reference (status lookups only)
 */
export type TopupState = 'success' | 'pending' | 'failed' | 'not_found'

export interface TopupResult {
  state: TopupState
  reference: string
  providerTransactionId?: string
  /** Provider's own status word, e.g. "delivered". */
  providerStatus?: string
  message?: string
  /** Prepaid electricity token for the customer's meter. */
  token?: string
  /** e.g. "79.9 kWh" */
  units?: string
}

export type TopupStatus = TopupResult

export type MeterVerification =
  | { valid: true; customerName: string; address?: string }
  | { valid: false; message: string }

export interface DataPlan {
  code: string
  name: string
  amountNgn: number
}

export interface TopupProvider {
  readonly name: string

  /** A fresh, unique reference in the format this provider requires. */
  createReference(): string

  buyAirtime(input: { network: Network; phone: string; amount: number; reference: string }): Promise<TopupResult>

  buyData(input: {
    network: Network
    phone: string
    planCode: string
    amount: number
    reference: string
  }): Promise<TopupResult>

  listDataPlans(network: Network): Promise<DataPlan[]>

  /** Check a meter exists before the customer pays. Throws if the provider can't be reached. */
  verifyMeter(input: { disco: Disco; meterType: MeterType; meterNumber: string }): Promise<MeterVerification>

  buyElectricity(input: {
    disco: Disco
    meterType: MeterType
    meterNumber: string
    phone: string
    amount: number
    reference: string
  }): Promise<TopupResult>

  getStatus(reference: string): Promise<TopupStatus>
}
