import { createPublicClient, http } from 'viem'
import { celo } from 'viem/chains'
import { serverConfig } from './env'

// Single transport boundary for campaign reads and finalized draw snapshots.
export function challengeClient() {
  return createPublicClient({ chain: celo, transport: http(serverConfig().chain.rpcUrl) })
}
