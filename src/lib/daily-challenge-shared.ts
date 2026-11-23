import { encodeAbiParameters, keccak256, parseAbi, toBytes, type Address } from 'viem'

export const challengeAbi = parseAbi([
  'function enter(uint256 day, bytes32 challengeId, bytes signature)',
  'function entered(uint256 day, address user) view returns (bool)',
  'function progress(address user) view returns (uint256 lastDay, uint256 streak)',
  'function startDay() view returns (uint256)',
  'function endDay() view returns (uint256)',
  'function paused() view returns (bool)',
  'function completionSigner() view returns (address)',
  'function identity() view returns (address)',
  'function entryCount(uint256 day) view returns (uint256)',
  'function participantAt(uint256 day, uint256 index) view returns (address)',
  'event DailyEntry(address indexed user, uint256 indexed day, bytes32 indexed challengeId, uint256 streak)',
])

export const challengeDay = (now = Date.now()) => Math.floor((now + 3_600_000) / 86_400_000)
export const dayLabel = (day: number) => new Date(day * 86_400_000).toISOString().slice(0, 10)
export const dayClosesAt = (day: number) => (day + 1) * 86_400_000 - 3_600_000
export const challengeId = (day: number) => keccak256(toBytes(`jara:daily:v1:${day}`))
export function completionHash(contract: Address, user: Address, day: number) {
  return keccak256(
    encodeAbiParameters(
      [{ type: 'uint256' }, { type: 'address' }, { type: 'address' }, { type: 'uint256' }, { type: 'bytes32' }],
      [42220n, contract, user, BigInt(day), challengeId(day)],
    ),
  )
}

export interface ChallengeView {
  available: boolean
  reason: string | null
  contract: Address | null
  day: number
  date: string
  closesAt: number
  title: string
  questions: { prompt: string; options: string[] }[]
  review: { correctOption: number; explanation: string; selected: number }[] | null
  entered: boolean
  streak: number
  week: { label: string; entered: boolean; today: boolean }[]
  entryCount: number
  results: { day: number; date: string; entrants: number; winners: { wallet: string; delivered: boolean }[] }[]
  prizes: { day: number; date: string; delivered: boolean; phone: string | null; network: string | null }[]
}
