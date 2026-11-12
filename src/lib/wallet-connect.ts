'use client'

// Browser-side wallet helpers: find every wallet the person has (EIP-6963 extensions,
// legacy window.ethereum, or a phone wallet via WalletConnect) and, when their wallet
// isn't GoodDollar-verified yet, send them to GoodDollar face verification for it.

import { createPublicClient, createWalletClient, custom, getAddress, http, type Address, type EIP1193Provider } from 'viem'
import { celo } from 'viem/chains'

export type WalletOption = { id: string; name: string; icon?: string; provider: EIP1193Provider }

type AnnounceEvent = CustomEvent<{ info: { uuid: string; name: string; icon: string; rdns: string }; provider: EIP1193Provider }>

export const WALLETCONNECT_PROJECT_ID = process.env.NEXT_PUBLIC_WALLETCONNECT_PROJECT_ID ?? ''

/** Every browser wallet that announces itself (MetaMask, Rabby, Coinbase, Valora, MiniPay…). */
export function discoverWallets(waitMs = 400): Promise<WalletOption[]> {
  if (typeof window === 'undefined') return Promise.resolve([])
  return new Promise((resolve) => {
    const found = new Map<string, WalletOption>()
    const onAnnounce = (e: Event) => {
      const { info, provider } = (e as AnnounceEvent).detail
      if (!found.has(info.rdns)) found.set(info.rdns, { id: info.rdns, name: info.name, icon: info.icon, provider })
    }
    window.addEventListener('eip6963:announceProvider', onAnnounce)
    window.dispatchEvent(new Event('eip6963:requestProvider'))
    window.setTimeout(() => {
      window.removeEventListener('eip6963:announceProvider', onAnnounce)
      const list = [...found.values()]
      // Older wallets and in-app browsers (MiniPay, Opera) only set window.ethereum.
      const legacy = (window as unknown as { ethereum?: EIP1193Provider & { isMiniPay?: boolean; isMetaMask?: boolean } }).ethereum
      if (list.length === 0 && legacy) {
        list.push({ id: 'injected', name: legacy.isMiniPay ? 'MiniPay' : legacy.isMetaMask ? 'MetaMask' : 'Browser wallet', provider: legacy })
      }
      resolve(list)
    }, waitMs)
  })
}

/** Opens the WalletConnect QR / deep-link modal so any phone wallet can connect. */
export async function connectWalletConnect(): Promise<EIP1193Provider> {
  if (!WALLETCONNECT_PROJECT_ID) throw new Error('WalletConnect is not set up on this site.')
  const { EthereumProvider } = await import('@walletconnect/ethereum-provider')
  const wc = await EthereumProvider.init({
    projectId: WALLETCONNECT_PROJECT_ID,
    optionalChains: [celo.id],
    showQrModal: true,
    metadata: {
      name: 'Jara',
      description: 'Your AI agent for GoodDollar',
      url: window.location.origin,
      icons: [`${window.location.origin}/icon.svg`],
    },
  })
  await wc.connect()
  return wc as unknown as EIP1193Provider
}

/** Asks the wallet for its address. */
export async function requestAddress(provider: EIP1193Provider): Promise<Address> {
  const [addr] = (await provider.request({ method: 'eth_requestAccounts' })) as string[]
  if (!addr) throw new Error('Your wallet did not share an address. Unlock it and try again.')
  return getAddress(addr)
}

/** GoodDollar face-verification link for this wallet; the person signs one message, no gas. */
export async function faceVerificationLink(provider: EIP1193Provider, account: Address, returnTo: string): Promise<string> {
  const { IdentitySDK } = await import('@goodsdks/citizen-sdk')
  const walletClient = createWalletClient({ account, chain: celo, transport: custom(provider) })
  const publicClient = createPublicClient({ chain: celo, transport: http() })
  // The SDK's client generics are wider than viem's concrete ones; the runtime objects match.
  const sdk = new IdentitySDK({
    account,
    publicClient: publicClient as never,
    walletClient: walletClient as never,
    env: 'production',
  })
  return sdk.generateFVLink(false, returnTo, celo.id)
}

/** Turns wallet errors into something a person can act on. */
export function walletErrorMessage(err: unknown): string {
  const e = err as { code?: number; message?: string; shortMessage?: string }
  if (/User closed the modal|Connection cancelled|didn’t connect/i.test(e?.message ?? '')) return 'Not connected. Tap Connect wallet to try again.'
  if (e?.code === 4001 || /reject|denied|cancel/i.test(e?.message ?? '')) return 'You cancelled in your wallet. Tap again when you’re ready.'
  if (e?.code === -32002) return 'Your wallet already has a request open. Open your wallet and finish or close it.'
  return (e?.shortMessage ?? e?.message ?? 'Something went wrong with your wallet').split('\n')[0].slice(0, 160)
}
