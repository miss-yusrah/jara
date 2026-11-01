// Shared by client and server: networks, products, phone handling, formatting.

export const NETWORKS = ['mtn', 'airtel', 'glo', '9mobile'] as const
export type Network = (typeof NETWORKS)[number]

export const PRODUCTS = ['airtime', 'data', 'electricity'] as const
export type Product = (typeof PRODUCTS)[number]

export const NETWORK_INFO: Record<Network, { label: string; brand: string; ink: string }> = {
  mtn: { label: 'MTN', brand: '#FFCB05', ink: '#1F2348' },
  airtel: { label: 'Airtel', brand: '#E40000', ink: '#FFFFFF' },
  glo: { label: 'Glo', brand: '#50B651', ink: '#FFFFFF' },
  '9mobile': { label: '9mobile', brand: '#006E53', ink: '#FFFFFF' },
}

// Number prefixes as allocated by the NCC. Ported numbers break this, so the
// detected network is only a default the user can override.
const PREFIXES: Record<Network, string[]> = {
  mtn: ['0703', '0704', '0706', '0803', '0806', '0810', '0813', '0814', '0816', '0903', '0906', '0913', '0916', '07025', '07026'],
  airtel: ['0701', '0708', '0802', '0808', '0812', '0901', '0902', '0904', '0907', '0911', '0912'],
  glo: ['0705', '0805', '0807', '0811', '0815', '0905', '0915'],
  '9mobile': ['0809', '0817', '0818', '0908', '0909'],
}

export const DISCOS = [
  'ikeja', 'eko', 'abuja', 'ibadan', 'enugu', 'portharcourt', 'benin', 'kano', 'kaduna', 'jos', 'aba', 'yola',
] as const
export type Disco = (typeof DISCOS)[number]

// Minimum vend amounts as published by VTpass per distribution company.
export const DISCO_INFO: Record<Disco, { short: string; name: string; region: string; minNgn: number }> = {
  ikeja: { short: 'IKEDC', name: 'Ikeja Electric', region: 'Lagos (Ikeja)', minNgn: 500 },
  eko: { short: 'EKEDC', name: 'Eko Electric', region: 'Lagos (Eko)', minNgn: 1000 },
  abuja: { short: 'AEDC', name: 'Abuja Electric', region: 'FCT, Niger, Kogi, Nasarawa', minNgn: 900 },
  ibadan: { short: 'IBEDC', name: 'Ibadan Electric', region: 'Oyo, Ogun, Osun, Kwara', minNgn: 2000 },
  enugu: { short: 'EEDC', name: 'Enugu Electric', region: 'Enugu, Anambra, Ebonyi, Abia, Imo', minNgn: 500 },
  portharcourt: { short: 'PHED', name: 'Port Harcourt Electric', region: 'Rivers, Bayelsa, Cross River, Akwa Ibom', minNgn: 100 },
  benin: { short: 'BEDC', name: 'Benin Electric', region: 'Edo, Delta, Ondo, Ekiti', minNgn: 500 },
  kano: { short: 'KEDCO', name: 'Kano Electric', region: 'Kano, Jigawa, Katsina', minNgn: 500 },
  kaduna: { short: 'KAEDCO', name: 'Kaduna Electric', region: 'Kaduna, Kebbi, Sokoto, Zamfara', minNgn: 1100 },
  jos: { short: 'JED', name: 'Jos Electric', region: 'Plateau, Bauchi, Benue, Gombe', minNgn: 1000 },
  aba: { short: 'ABEDC', name: 'Aba Power', region: 'Aba', minNgn: 100 },
  yola: { short: 'YEDC', name: 'Yola Electric', region: 'Adamawa, Taraba', minNgn: 500 },
}

export const METER_TYPES = ['prepaid', 'postpaid'] as const
export type MeterType = (typeof METER_TYPES)[number]

export const ELECTRICITY_PRESETS = [1000, 2000, 5000, 10000] as const

// VTpass sandbox meters; any other meter number fails verification there.
export const SANDBOX_TEST_METERS = [
  { meter: '1111111111111', type: 'prepaid' },
  { meter: '1010101010101', type: 'postpaid' },
] as const

// VTpass sandbox numbers that force a specific outcome.
export const SANDBOX_TEST_NUMBERS = [
  { phone: '08011111111', outcome: 'Success' },
  { phone: '201000000000', outcome: 'Pending' },
  { phone: '500000000000', outcome: 'Unexpected response' },
  { phone: '400000000000', outcome: 'No response' },
  { phone: '300000000000', outcome: 'Timeout' },
] as const

export const AIRTIME_PRESETS = [100, 200, 500, 1000, 2000, 5000] as const

export const LUNA_PER_NIM = 100_000

export function isNetwork(value: unknown): value is Network {
  return typeof value === 'string' && (NETWORKS as readonly string[]).includes(value)
}

export function isDisco(value: unknown): value is Disco {
  return typeof value === 'string' && (DISCOS as readonly string[]).includes(value)
}

export function isMeterType(value: unknown): value is MeterType {
  return value === 'prepaid' || value === 'postpaid'
}

/** Meter or account number with spaces removed, or null if implausible. */
export function normalizeMeterNumber(input: string): string | null {
  const compact = input.replace(/\s+/g, '')
  return /^[0-9][0-9-]{5,19}$/.test(compact) ? compact : null
}

/** "Token : 2636 2054…" → "2636 2054 4059 8275 7802" */
export function formatToken(token: string): string {
  const digits = token.replace(/^\s*token\s*:\s*/i, '').replace(/\s+/g, '')
  return /^\d+$/.test(digits) ? digits.replace(/(\d{4})(?=\d)/g, '$1 ') : digits
}

export function isProduct(value: unknown): value is Product {
  return typeof value === 'string' && (PRODUCTS as readonly string[]).includes(value)
}

/** Returns the number in local 11-digit form (0803…), or null if invalid. */
export function normalizePhone(input: string, allowTestNumbers = false): string | null {
  const digits = input.replace(/[\s\-()]/g, '').replace(/^\+/, '')
  if (allowTestNumbers && SANDBOX_TEST_NUMBERS.some((t) => t.phone === digits)) return digits
  const local = digits.startsWith('234') ? `0${digits.slice(3)}` : digits
  return /^0[789][01]\d{8}$/.test(local) ? local : null
}

export function detectNetwork(phone: string): Network | null {
  for (const network of NETWORKS) {
    if (PREFIXES[network].some((prefix) => phone.startsWith(prefix))) return network
  }
  return null
}

export function formatPhone(phone: string): string {
  return phone.length === 11 ? `${phone.slice(0, 4)} ${phone.slice(4, 7)} ${phone.slice(7)}` : phone
}

export function formatNgn(amount: number): string {
  return `₦${amount.toLocaleString('en-NG', { maximumFractionDigits: 2 })}`
}

export function formatNim(luna: number): string {
  return (luna / LUNA_PER_NIM).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 5 })
}
