import { createPublicClient, http, type Address } from 'viem'
import { celo } from 'viem/chains'
import { serverConfig } from '../env'
import { flowAllocation, readFlowSnapshot } from '../flowstate'

/**
 * Optional entry gate (STREAK_REQUIRE_FLOWSTATE=true): the verified wallet gives Jara at least one
 * Flowstate vote right now. Read live from the council; nothing is stored. Demo mode always passes.
 */
export async function votesForJara(root: Address): Promise<boolean> {
  if (serverConfig().chain.mode === 'mock') return true
  const client = createPublicClient({ chain: celo, transport: http(serverConfig().chain.rpcUrl) })
  return flowAllocation(await readFlowSnapshot(client, root)).current > 0n
}
