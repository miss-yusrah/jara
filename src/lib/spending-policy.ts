// ABI shared with the browser; no server imports here.
import { parseAbi } from 'viem'

export const spendingPolicyAbi = parseAbi([
  'function gd() view returns (address)',
  'function operator() view returns (address)',
  'function recipient() view returns (address)',
  'function available(address owner) view returns (uint256)',
  'function configure(uint256 total, uint256 dailyLimit, uint256 validUntil)',
  'function charge(address owner, uint256 amount, bytes32 id)',
])
export const POLICY_DAILY_GD = 1000
export const POLICY_DAYS = 30
