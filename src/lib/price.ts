import { formatEther, parseEther } from 'viem'
import { serverConfig } from './env'

// How many naira one G$ buys. CoinGecko quotes G$ directly in NGN.
let cache: { rate: number; at: number } | null = null
const TTL = 5 * 60_000
const DEMO_RATE = 0.15 // used only if CoinGecko is unreachable in demo mode

export async function ngnPerGd(): Promise<number> {
  const { fixedNgnPerGd } = serverConfig().pricing
  if (fixedNgnPerGd > 0) return fixedNgnPerGd
  if (cache && Date.now() - cache.at < TTL) return cache.rate
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=gooddollar&vs_currencies=ngn', {
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    })
    const json = (await res.json()) as { gooddollar?: { ngn?: number } }
    const rate = json.gooddollar?.ngn
    if (!rate || !Number.isFinite(rate)) throw new Error('no G$ price')
    cache = { rate, at: Date.now() }
    return rate
  } catch (err) {
    if (cache) return cache.rate
    if (serverConfig().chain.mode === 'mock') return DEMO_RATE
    throw err
  }
}

/** G$ (wei) needed to pay a naira amount, including the spread that covers swap + fees. */
export async function gdForNgn(ngn: number): Promise<bigint> {
  const rate = await ngnPerGd()
  const gd = (ngn / rate) * (1 + serverConfig().pricing.spreadBps / 10_000)
  return parseEther(gd.toFixed(6))
}

/** Naira value of a G$ (wei) amount at the current rate, before spread. */
export async function ngnForGd(wei: bigint): Promise<number> {
  return Math.floor(Number(formatEther(wei)) * (await ngnPerGd()))
}

// G$ in US dollars, for comparing G$ received against USDC spent on AI.
let usdCache: { rate: number; at: number } | null = null
const DEMO_USD_RATE = 0.0001

export async function usdPerGd(): Promise<number> {
  if (process.env.GD_USD_RATE) return Number(process.env.GD_USD_RATE)
  if (usdCache && Date.now() - usdCache.at < TTL) return usdCache.rate
  try {
    const res = await fetch('https://api.coingecko.com/api/v3/simple/price?ids=gooddollar&vs_currencies=usd', {
      cache: 'no-store',
      signal: AbortSignal.timeout(8000),
    })
    const json = (await res.json()) as { gooddollar?: { usd?: number } }
    const rate = json.gooddollar?.usd
    if (!rate || !Number.isFinite(rate)) throw new Error('no G$ price')
    usdCache = { rate, at: Date.now() }
    return rate
  } catch (err) {
    if (usdCache) return usdCache.rate
    if (serverConfig().chain.mode === 'mock') return DEMO_USD_RATE
    throw err
  }
}
