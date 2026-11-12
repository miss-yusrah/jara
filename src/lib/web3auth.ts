'use client'

// One "Connect" button for phone and web, using Jara’s own Web3Auth project
// (Modal v10, Sapphire mainnet, same setup as Action Order): Google / email login creates a wallet, and the same modal
// offers MetaMask, WalletConnect and other external wallets. MiniPay is the exception: its
// built-in wallet is used directly, because Web3Auth's MetaMask SDK breaks inside it.

import type { EIP1193Provider } from 'viem'
import { celo, mainnet } from 'viem/chains'

const CLIENT_ID = process.env.NEXT_PUBLIC_WEB3AUTH_CLIENT_ID ?? ''
const RPC = 'https://forno.celo.org'
const RESUME_KEY = 'jara:w3a-connecting'

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- the SDK's types are loaded lazily
type Web3AuthInstance = any
let instance: Web3AuthInstance | null = null
let initPromise: Promise<Web3AuthInstance> | null = null

type Injected = EIP1193Provider & { isMiniPay?: boolean }
const injected = (): Injected | null =>
  typeof window === 'undefined' ? null : ((window as unknown as { ethereum?: Injected }).ethereum ?? null)

export const isMiniPay = () => Boolean(injected()?.isMiniPay)
export const web3AuthConfigured = () => Boolean(CLIENT_ID)

export function isMobileBrowser() {
  if (typeof navigator === 'undefined') return false
  const ua = navigator.userAgent
  // iPadOS and "Request desktop site" iPhones report Macintosh; touch points give them away.
  const desktopModeIOS = /Macintosh/.test(ua) && navigator.maxTouchPoints > 1
  return /Android|iPhone|iPad|iPod|Opera Mini|IEMobile|WPDesktop/i.test(ua) || desktopModeIOS
}

async function getWeb3Auth(): Promise<Web3AuthInstance> {
  if (isMiniPay()) throw new Error('Web3Auth is not used inside MiniPay.')
  if (!CLIENT_ID) throw new Error('Wallet sign-in is not set up on this site yet.')
  if (instance) return instance
  if (initPromise) return initPromise
  initPromise = (async () => {
    const { Web3Auth, WEB3AUTH_NETWORK, fromViemChain } = await import('@web3auth/modal')
    const mobile = isMobileBrowser()
    const w3a = new Web3Auth({
      clientId: CLIENT_ID,
      web3AuthNetwork: WEB3AUTH_NETWORK.SAPPHIRE_MAINNET,
      chains: [{ ...fromViemChain(celo), rpcTarget: RPC }, ...(mobile ? [fromViemChain(mainnet)] : [])],
      // Phones: connect on Ethereum, where MetaMask normally already is. Connecting on Celo
      // makes Web3Auth ask MetaMask to switch chains straight after it approves, a second trip
      // to the MetaMask app that phone Chrome blocks without a tap, so it hung on "Connecting…".
      // Every Jara approval switches to Celo itself, on the person's tap.
      defaultChainId: `0x${(mobile ? mainnet : celo).id.toString(16)}`,
      // Phone browsers block popups: log in by redirect and come back.
      ...(isMobileBrowser() && { uiConfig: { uxMode: 'redirect' as const } }),
    })
    const init = w3a.init()
    void init.then(() => (instance = w3a), () => {})
    await Promise.race([init, new Promise((_, reject) => setTimeout(() => reject(new Error('Wallet sign-in took too long. Try again.')), 15_000))])
    instance = w3a
    return w3a
  })()
  // A failed init must not block every later try.
  initPromise.catch(() => (initPromise = null))
  return initPromise
}

/** Start loading the SDK on hover/press so the tap itself opens the modal quickly. */
export function prewarmWallet() {
  if (typeof window === 'undefined' || isMiniPay() || !CLIENT_ID) return
  void getWeb3Auth().catch(() => {})
}

/**
 * The wallet to use: MiniPay's own, an existing Web3Auth session, or the Web3Auth modal.
 * On phones, social login leaves the page and comes back; `resumeWallet` picks it up.
 */
export async function getWalletProvider(): Promise<EIP1193Provider> {
  const own = injected()
  if (own && isMiniPay()) return own
  if (!CLIENT_ID) {
    if (own) return own
    throw new Error('No wallet found. Open Jara in your wallet app’s browser.')
  }
  const w3a = await getWeb3Auth()
  if (w3a.connected && w3a.provider) return w3a.provider as EIP1193Provider
  try {
    window.sessionStorage.setItem(RESUME_KEY, '1')
  } catch {
    /* private browsing */
  }
  try {
    const provider = await connectWithEscape(w3a)
    if (!provider) throw new Error('Wallet didn’t connect. Try again.')
    return provider
  } finally {
    try {
      window.sessionStorage.removeItem(RESUME_KEY)
    } catch {
      /* private browsing */
    }
  }
}

let cancelPending: (() => void) | null = null

/** Stop waiting for a connect that is stuck (shown as a "Cancel" link while connecting). */
export function cancelConnect() {
  cancelPending?.()
}

/**
 * w3a.connect(), but it always settles. The SDK only rejects when the modal closes if it hears
 * the close on a one-shot listener that the modal's own "opened" event already used up, so a
 * closed modal (or MetaMask's app opening and hiding it) left the promise, and our button,
 * hanging on "Connecting…" forever. Here: connected → resolve; modal closed and nothing in
 * progress → reject; came back from a wallet app and still not connected after a while →
 * reject; or the person taps Cancel.
 */
function connectWithEscape(w3a: Web3AuthInstance): Promise<EIP1193Provider> {
  return new Promise<EIP1193Provider>((resolve, reject) => {
    let settled = false
    const timers: number[] = []
    const later = (ms: number, fn: () => void) => timers.push(window.setTimeout(fn, ms))
    const connected = () => (w3a.connected && w3a.provider ? (w3a.provider as EIP1193Provider) : null)
    const finish = (fn: () => void) => {
      if (settled) return
      settled = true
      timers.forEach((t) => window.clearTimeout(t))
      w3a.removeListener?.('MODAL_VISIBILITY', onVisibility)
      w3a.removeListener?.('connected', onConnected)
      w3a.removeListener?.('errored', onError)
      document.removeEventListener('visibilitychange', onPageVisible)
      cancelPending = null
      fn()
    }
    const fail = (message: string) => finish(() => reject(new Error(message)))
    const onConnected = () => {
      const p = connected()
      if (p) finish(() => resolve(p))
    }
    const onError = (err: unknown) => finish(() => reject(err instanceof Error ? err : new Error('Wallet didn’t connect. Try again.')))
    const onVisibility = (visible: boolean) => {
      if (visible) return
      // Give a just-finished login a moment to report "connected".
      later(1200, () => {
        if (connected()) return onConnected()
        if (w3a.status === 'connecting') return // e.g. waiting in the MetaMask app
        fail('Wallet didn’t connect. Try again.')
      })
    }
    // Back from a wallet app (MetaMask on a phone): pick up a connection that finished there.
    const onPageVisible = () => {
      if (document.visibilityState !== 'visible') return
      later(1500, () => {
        if (connected()) onConnected()
      })
    }
    cancelPending = () => fail('Connection cancelled.')

    w3a.on?.('MODAL_VISIBILITY', onVisibility)
    w3a.on?.('connected', onConnected)
    w3a.on?.('errored', onError)
    document.addEventListener('visibilitychange', onPageVisible)

    w3a.connect().then(
      (p: EIP1193Provider | null) => (p ? finish(() => resolve(p)) : onConnected()),
      (err: unknown) => onError(err),
    )
  })
}

/** After a phone login redirect: the restored wallet, if the person was mid-connect. */
export async function resumeWallet(): Promise<EIP1193Provider | null> {
  let pending = false
  try {
    pending = window.sessionStorage.getItem(RESUME_KEY) === '1'
    window.sessionStorage.removeItem(RESUME_KEY)
  } catch {
    /* private browsing */
  }
  if (!pending || isMiniPay() || !CLIENT_ID) return null
  const w3a = await getWeb3Auth().catch(() => null)
  return w3a?.connected && w3a.provider ? (w3a.provider as EIP1193Provider) : null
}

/** Sign out of Web3Auth so the next Connect can pick a different wallet or login. */
export async function switchWallet() {
  if (isMiniPay() || !CLIENT_ID) return
  const w3a = await getWeb3Auth().catch(() => null)
  if (w3a?.connected) await w3a.logout().catch(() => {})
}
