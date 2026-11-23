import { formatEther } from 'viem'
import { entitlement, ubiClaimPeriod, whitelistedRoot } from './chain'
import { claimAddress } from './claimers'
import { serverConfig } from './env'
import type { User } from './users'

export interface ClaimHealth {
  status: 'ready' | 'waiting' | 'reconnect' | 'verify' | 'unknown' | 'demo'
  message: string
  nextPeriodAt?: number
}

/** Read-only: an unavailable RPC must never be interpreted as a broken link. */
export async function claimHealth(user: User): Promise<ClaimHealth> {
  if (serverConfig().chain.mode === 'mock') return { status: 'demo', message: 'Claims in this preview use simulated G$.' }
  if (!user.connected || !user.rootAddress) return { status: 'reconnect', message: 'Connect your GoodDollar account to enable automatic claims.' }
  try {
    const [root, linked] = await Promise.all([
      whitelistedRoot(user.rootAddress),
      whitelistedRoot(claimAddress(user)),
    ])
    if (!root || root.toLowerCase() !== user.rootAddress.toLowerCase()) {
      return { status: 'verify', message: 'Your GoodDollar identity needs verification. Renew it to resume automatic claims.' }
    }
    if (!linked || linked.toLowerCase() !== root.toLowerCase()) {
      return { status: 'reconnect', message: 'Automatic claims are paused because your claim wallet is no longer linked. Reconnect it with your GoodDollar wallet.' }
    }
    const amount = await entitlement(claimAddress(user))
    if (amount > 0n) return { status: 'ready', message: `G$ ${Number(formatEther(amount)).toLocaleString('en-US', { maximumFractionDigits: 2 })} is ready. Jara checks automatically every hour, or you can claim now.` }
    const period = await ubiClaimPeriod()
    return { status: 'waiting', message: 'Your wallet link is working. No G$ is available right now; Jara will check again automatically.', nextPeriodAt: period.endsAt }
  } catch {
    return { status: 'unknown', message: 'The network check did not finish. Your claim status is unconfirmed; try checking again shortly.' }
  }
}
