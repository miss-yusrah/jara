'use client'

import Link from 'next/link'
import { clientRequest } from '@/lib/client-request'
import { ApiError, readApiResponse } from '@/lib/api-response'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPublicClient, createWalletClient, custom, http, parseEther, type EIP1193Provider } from 'viem'
import { celo } from 'viem/chains'
import { DISCOS, DISCO_INFO, NETWORKS, NETWORK_INFO, detectNetwork, formatNgn } from '@/lib/catalog'
import { Icon, type IconName } from './Icon'
import { Jar, type JarColor, type JarIcon } from './Jar'
import { Markdown } from './Markdown'
import { walletLoginMessage } from '@/lib/wallet-login'
import { useSheetDialog } from './useSheetDialog'
import { DashboardNav, dashboardView, type DashboardView } from './DashboardNav'
import { faceVerificationLink, requestAddress, walletErrorMessage } from '@/lib/wallet-connect'
import { cancelConnect, getWalletProvider, prewarmWallet, resumeWallet, switchWallet } from '@/lib/web3auth'

// ---------- types mirrored from /api/_shared userState ----------

interface JarView {
  kind: 'light' | 'data' | 'airtime' | 'ai'
  label: string
  emoji: string
  balanceGd: number
  balanceNgn: number
  targetNgn: number
  pct: number
  autoPay: boolean
  details: { phone?: string; network?: string; disco?: string; meterType?: string; meterNumber?: string; customerName?: string }
  everyDays: number | null
  dueAt: number | null
}
interface Activity {
  id: number
  type: string
  title: string
  detail: string | null
  status: string
  amountWei: string | null
  txHash: string | null
  createdAt: number
}
interface Msg {
  id: number
  role: string
  content: string
}
interface State {
  user: {
    id: string
    name: string | null
    rootAddress: string | null
    agentAddress: string
    connected: boolean
    streak: number
    telegramLinked: boolean
    telegramLink: string | null
    hasPending: boolean
    pendingId: string | null
    lastRunAt: number | null
    inviteLink: string
  }
  aiRuns: { id: number; tool: string; input: string; output: string; costGd: number; demo: boolean; createdAt: number }[]
  aiTools: { id: string; name: string; blurb: string; priceGd: number; placeholder: string }[]
  rewards: { earnedGd: number; items: { title: string; detail: string; amountGd: number; done: boolean; progress: number }[] }
  jobs: {
    exam: { on: boolean; exam: string | null; subjects: string[]; date: string | null; daysLeft: number | null; drillsDone: number; priceGd: number; options: string[] }
    scout: { on: boolean; interests: string | null; lastAt: number | null; priceGd: number }
    verification: { expiresAt: number | null; daysLeft: number | null }
  }
  snapshot: { jars: JarView[]; totalGd: number; freeGd: number; freeNgn: number; ngnPerGd: number; walletGd: number | null; gas: { celo: number; perTxCelo: number } | null; mode: 'wallet' | 'jar'; claimedGd: number; limitLeftGd: number; feesOwedGd: number }
  activity: Activity[]
  messages: Msg[]
  config: { chainMode: 'celo' | 'mock'; provider: string; billsLive: boolean; llm: string; treasury: string | null; limitGd: number }
}

const JAR_COLOR: Record<JarView['kind'], JarColor> = { light: 'crest', data: 'mandarin', airtime: 'forest', ai: 'mandarin' }
const JAR_ICON: Record<JarView['kind'], JarIcon> = { light: 'bolt', data: 'signal', airtime: 'phone', ai: 'spark' }
const JAR_LID: Record<JarView['kind'], string> = { light: '#ffc72c', data: '#ffc72c', airtime: '#ff6b00', ai: '#1d5a3f' }
const IDENTITY = '0xC361A6E67822a0EDc17D899227dd9FC50BD62F42'
const CONNECT_ABI = [
  { type: 'function', name: 'connectAccount', stateMutability: 'nonpayable', inputs: [{ name: 'account', type: 'address' }], outputs: [] },
] as const
const GD_TOKEN = '0x62B8B11039FcfE5aB0C56E502b1C372A3d2a9c7A'
const APPROVE_ABI = [
  { type: 'function', name: 'approve', stateMutability: 'nonpayable', inputs: [{ name: 'spender', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
] as const

/** Ask the person's wallet to set Jara's spending limit (0 turns it off). */
async function setSpendingLimit(provider: EIP1193Provider, spender: string, gd: number) {
  const wallet = createWalletClient({ chain: celo, transport: custom(provider) })
  const [account] = await wallet.requestAddresses()
  await wallet.switchChain({ id: celo.id }).catch(() => wallet.addChain({ chain: celo }))
  const hash = await wallet.writeContract({
    account,
    address: GD_TOKEN,
    abi: APPROVE_ABI,
    functionName: 'approve',
    args: [spender as `0x${string}`, parseEther(String(Math.max(0, Math.floor(gd))))],
  })
  await createPublicClient({ chain: celo, transport: http() }).waitForTransactionReceipt({ hash, timeout: 90_000 })
  return { account, hash }
}

async function api<T>(path: string, body?: unknown, method?: 'DELETE'): Promise<T> {
  const saved = body !== undefined && ['/api/chat', '/api/ai', '/api/wallet', '/api/jars'].includes(path) ? clientRequest(path, body) : null
  const payload = saved ? { ...(body as object), requestId: saved.id } : body
  const res = await fetch(path, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { 'content-type': 'application/json' },
    body: payload === undefined ? undefined : JSON.stringify(payload),
  }).catch(() => { throw new ApiError('The connection was interrupted. Please retry this same request to check its result.', 'network', 0, true) })
  const json = await readApiResponse<T>(res)
  saved?.finish()
  return json
}

/** Prove a wallet is yours with one free signature and open its Jara account. */
async function signInWithWallet(provider: EIP1193Provider): Promise<State> {
  const wallet = createWalletClient({ chain: celo, transport: custom(provider) })
  const [account] = await wallet.requestAddresses()
  const issuedAt = Date.now()
  const signature = await wallet.signMessage({ account, message: walletLoginMessage(account, issuedAt) })
  return api<State>('/api/session/wallet', { address: account, issuedAt, signature })
}

/** Sign out on this device and disconnect the wallet. The account stays. */
async function signOut() {
  await switchWallet().catch(() => {})
  await api('/api/session', undefined, 'DELETE')
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
const gdFmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 0 })

// ---------- root ----------

export function AppClient({ tgCode, refCode }: { tgCode?: string; refCode?: string }) {
  const [state, setState] = useState<State | null | undefined>(undefined)
  const [toast, setToast] = useState<string | null>(null)
  const [profileOpen, setProfileOpen] = useState(false)
  // The wallet connected on the welcome screen, handed to setup so it isn't asked for twice.
  const [startWallet, setStartWallet] = useState<EIP1193Provider | null>(null)
  const leave = useCallback(async () => {
    await signOut().catch(() => {})
    setProfileOpen(false)
    setStartWallet(null)
    setState(null)
  }, [])

  const flash = useCallback((t: string) => {
    setToast(t)
    window.setTimeout(() => setToast(null), 3500)
  }, [])

  useEffect(() => {
    ;(async () => {
      if (tgCode) {
        window.history.replaceState(null, '', '/app')
        try {
          setState(await api<State>('/api/session', { tg: tgCode }))
          return
        } catch (err) {
          flash(err instanceof Error ? err.message : 'That link has expired. Send /start to the bot.')
        }
      }
      const s = await api<State | { user: null }>('/api/session')
      setState(s.user ? (s as State) : null)
    })().catch(() => setState(null))
  }, [tgCode, flash])

  // While a bill is still processing, keep checking so "Paying…" flips to "Paid" by itself.
  const hasPending = Boolean(state?.activity.some((a) => a.type === 'pay' && ['pending', 'refund_pending', 'settling'].includes(a.status)))
  useEffect(() => {
    if (!hasPending) return
    const id = window.setInterval(() => {
      api<State | { user: null }>('/api/session')
        .then((s) => {
          if (s.user) setState(s as State)
        })
        .catch(() => {})
    }, 20_000)
    return () => window.clearInterval(id)
  }, [hasPending])

  return (
    <div className="jara-app min-h-dvh">
      <TopBar state={state ?? null} onProfile={() => setProfileOpen(true)} onSignOut={leave} />
      {state === undefined && <Loading />}
      {state === null && <Welcome onStart={(s, provider) => { setStartWallet(provider); setState(s) }} refCode={refCode} />}
      {state && !state.user.connected && <Onboarding state={state} setState={setState} flash={flash} startWallet={startWallet} />}
      {state && state.user.connected && <Dashboard state={state} setState={setState} flash={flash} onProfile={() => setProfileOpen(true)} />}
      {state && state.user.connected && profileOpen && <ProfileSheet state={state} setState={setState} flash={flash} onClose={() => setProfileOpen(false)} onSignOut={leave} />}
      {toast && (
        <div role="status" className="fixed inset-x-0 bottom-24 z-50 flex justify-center px-4 lg:bottom-6">
          <p className="animate-pop max-w-md rounded-full bg-ink px-5 py-3 text-center font-bold text-cream shadow-[0_10px_30px_rgba(11,31,22,0.35)]">{toast}</p>
        </div>
      )}
    </div>
  )
}

/** Gas health of the Jara wallet: how many more on-chain actions it can pay for. */
function gasHealth(gas: State['snapshot']['gas']): { left: number; low: boolean; empty: boolean } | null {
  if (!gas || gas.perTxCelo <= 0) return null
  const left = Math.floor(gas.celo / gas.perTxCelo)
  return { left, low: left < 3, empty: gas.celo < gas.perTxCelo * 1.5 }
}

function TopBar({ state, onProfile, onSignOut }: { state: State | null; onProfile: () => void; onSignOut: () => void }) {
  const connected = Boolean(state?.user.connected)
  return (
    <header className="app-topbar">
      <div className="mx-auto flex h-[76px] max-w-[1600px] items-center justify-between gap-3 px-5 sm:px-8">
        <Link href={connected ? '/app' : '/'} className="flex items-center gap-2.5 text-forest" aria-label="Jara home">
          <span className="grid h-10 w-10 place-items-center rounded-[14px] bg-forest text-crest"><Icon name="jar" className="h-6 w-6" strokeWidth={1.8} /></span>
          <span className="text-[28px] font-extrabold tracking-[-0.06em]">jara<span className="text-mandarin">.</span></span>
        </Link>
        <div className="flex items-center gap-3 sm:gap-5">
          {state?.config.chainMode === 'mock' && <span className="rounded-full bg-crest/25 px-3 py-1.5 text-xs font-bold text-forest">Demo · simulated G$</span>}
          {connected ? <>
            <Link href="/app/ai" className="hidden items-center gap-2 text-sm font-bold text-forest sm:flex"><Icon name="sparkle" className="h-4 w-4" /> Jara AI</Link>
            <button onClick={onProfile} className="flex items-center gap-2 rounded-full border border-ink/10 bg-white py-1 pr-1 pl-1 text-left hover:border-forest/30 sm:pr-3.5" aria-label="Open your wallet and profile">
              <span className="grid h-8 w-8 place-items-center rounded-full bg-[#e5ecdf] text-sm font-bold text-forest">{state?.user.name?.slice(0, 1).toUpperCase() || 'J'}</span>
              <span className="hidden text-sm font-bold sm:block">{state?.user.name || 'Your account'}</span>
            </button>
          </> : state ? (
            <button onClick={onSignOut} className="text-sm font-semibold text-ink/55 underline hover:text-forest">Sign out</button>
          ) : <span className="text-xs font-semibold text-ink/50 sm:text-sm">A little, every day.</span>}
        </div>
      </div>
    </header>
  )
}

function Loading() {
  return (
    <div className="grid min-h-[70dvh] place-items-center">
      <Jar pct={55} className="h-32 animate-bob" />
    </div>
  )
}

// ---------- welcome ----------

function Welcome({ onStart, refCode }: { onStart: (s: State, provider: EIP1193Provider | null) => void; refCode?: string }) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState<'wallet' | 'name' | null>(null)
  const [error, setError] = useState<string | null>(null)
  // A wallet with no Jara account yet: ask for a name next.
  const [fresh, setFresh] = useState<{ provider: EIP1193Provider; address: string } | null>(null)
  // A wallet that already has an account: sign in on a tap (phone wallets need the tap to open).
  const [returning, setReturning] = useState<{ provider: EIP1193Provider; address: string } | null>(null)

  const openWallet = async (provider: EIP1193Provider) => {
    const address = await requestAddress(provider)
    const { exists } = await api<{ exists: boolean }>('/api/session/wallet', { action: 'check', address })
    if (exists) setReturning({ provider, address })
    else setFresh({ provider, address })
  }
  const connect = async (getProvider: () => Promise<EIP1193Provider>) => {
    setBusy('wallet')
    setError(null)
    try { await openWallet(await getProvider()) }
    catch (err) { setError(walletErrorMessage(err)) }
    finally { setBusy(null) }
  }

  // Phone logins leave the page and come back: carry on where they were.
  useEffect(() => {
    void resumeWallet().then((provider) => {
      if (provider) void connect(async () => provider)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on arrival
  }, [])

  return (
    <main className="mx-auto grid min-h-[calc(100dvh-76px)] max-w-5xl items-center gap-6 px-6 py-8 md:grid-cols-2 md:gap-16 md:py-16">
      <div>
        <p className="text-xs font-bold tracking-[0.16em] text-forest/60 uppercase">Welcome to your everyday companion</p>
        <h1 className="mt-5 text-4xl leading-[1.05] font-bold tracking-[-0.055em] sm:text-6xl">A little G$.<br /><span className="text-forest">More possibilities.</span></h1>
        <p className="mt-5 max-w-sm text-base leading-relaxed text-ink/60">Make your daily GoodDollar useful. Give it a purpose in your jars, get a hand from AI, and let Jara handle the little things.</p>
        <div aria-hidden="true" className="mt-8 hidden items-end gap-6 rounded-3xl bg-[#eaf0df] px-8 py-6 sm:flex">
          <Jar pct={60} color="crest" className="h-32" label={{ icon: 'bolt', text: 'Light' }} />
          <Jar pct={40} color="forest" className="h-28" label={{ icon: 'phone', text: 'Airtime' }} />
          <Jar pct={75} color="mandarin" lid="#1d5a3f" className="h-36" label={{ icon: 'spark', text: 'AI' }} />
        </div>
      </div>
      <section className="app-card p-6 sm:p-8">
        <span className="grid h-11 w-11 place-items-center rounded-xl bg-crest/25 text-forest"><Icon name={fresh ? 'sun' : 'coins'} className="h-6 w-6" /></span>
        {returning ? (
          <>
            <h2 className="mt-5 text-2xl font-bold tracking-tight">Welcome back.</h2>
            <p className="mt-2 text-sm text-ink/55">
              <span className="font-semibold text-ink tabular-nums">{short(returning.address)}</span> already has a Jara account. Sign one message to open it. It’s free and moves no money.
            </p>
            <div className="mt-7 grid gap-3">
              <button
                onClick={async () => {
                  setBusy('wallet')
                  setError(null)
                  try { onStart(await signInWithWallet(returning.provider), returning.provider) }
                  catch (err) { setError(walletErrorMessage(err)) }
                  finally { setBusy(null) }
                }}
                disabled={!!busy}
                className="app-button min-h-12 justify-center bg-forest text-sm text-cream hover:bg-forest-soft disabled:opacity-60"
              >
                {busy === 'wallet' ? 'Check your wallet…' : 'Sign in with this wallet'} <Icon name="arrow" className="h-4 w-4" />
              </button>
              {error && <p role="alert" className="text-sm text-red-800">{error}</p>}
              <button onClick={() => void switchWallet().then(() => setReturning(null))} className="text-center text-sm font-semibold text-forest underline">Use another wallet</button>
            </div>
          </>
        ) : !fresh ? (
          <>
            <h2 className="mt-5 text-2xl font-bold tracking-tight">Connect to get started.</h2>
            <p className="mt-2 text-sm text-ink/55">Use Google or email, MetaMask, or any wallet. Been here before? The same wallet opens your account.</p>
            <div className="mt-7 grid gap-3">
              <button
                onPointerEnter={prewarmWallet}
                onPointerDown={prewarmWallet}
                onClick={() => connect(getWalletProvider)}
                disabled={!!busy}
                className="app-button min-h-12 justify-center bg-forest text-sm text-cream hover:bg-forest-soft disabled:opacity-60"
              >
                {busy === 'wallet' ? 'Connecting…' : 'Connect wallet'} <Icon name="arrow" className="h-4 w-4" />
              </button>
              {busy === 'wallet' && <button type="button" onClick={cancelConnect} className="text-center text-sm font-semibold text-ink/55 underline">Stuck? Cancel</button>}
              {error && <p role="alert" className="text-sm text-red-800">{error}</p>}
            </div>
          </>
        ) : (
          <>
            <h2 className="mt-5 text-2xl font-bold tracking-tight">Let’s make it yours.</h2>
            <p className="mt-2 text-sm text-ink/55">
              Connected <span className="font-semibold text-ink tabular-nums">{short(fresh.address)}</span>.{' '}
              <button onClick={() => void switchWallet().then(() => setFresh(null))} className="font-semibold text-forest underline">Use another</button>
            </p>
            <form className="mt-7 grid gap-4" onSubmit={async (event) => {
              event.preventDefault()
              setBusy('name')
              setError(null)
              try { onStart(await api<State>('/api/session', { name, ref: refCode }), fresh.provider) }
              catch (err) { setError(err instanceof Error ? err.message : 'Could not get started. Please try again.') }
              finally { setBusy(null) }
            }}>
              <label className="grid gap-2 text-sm font-semibold">What should I call you?
                <input autoFocus value={name} onChange={(event) => setName(event.target.value)} autoComplete="given-name" maxLength={40} placeholder="e.g. Amaka" className="rounded-xl border border-ink/20 bg-[#fafbf7] px-4 py-3.5 text-base" />
              </label>
              {error && <p role="alert" className="text-sm text-red-800">{error}</p>}
              <button disabled={!!busy} className="app-button min-h-12 justify-center bg-forest text-sm text-cream hover:bg-forest-soft disabled:opacity-60">{busy === 'name' ? 'Setting up…' : 'Continue'} <Icon name="arrow" className="h-4 w-4" /></button>
            </form>
          </>
        )}
        <div className="mt-7 border-t border-ink/10 pt-5">
          <p className="text-xs font-bold tracking-wider text-ink/45 uppercase">Then we’ll help you</p>
          <ol className="mt-3 grid gap-3 text-sm text-ink/65">
            {['Verify once on GoodDollar, if you haven’t', 'Approve daily claims and a spending limit', 'Choose your budgets and optional jobs'].map((step, i) => <li key={step} className="flex items-center gap-3"><span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-[#edf2e8] text-xs font-bold text-forest">{i + 1}</span>{step}</li>)}
          </ol>
          <p className="mt-5 text-xs leading-relaxed text-ink/50">Already started on Telegram? Open the setup link from the bot to continue with your account.</p>
        </div>
      </section>
    </main>
  )
}

// ---------- onboarding ----------

function Onboarding({ state, setState, flash, startWallet }: { state: State; setState: (s: State) => void; flash: (t: string) => void; startWallet?: EIP1193Provider | null }) {
  const mock = state.config.chainMode === 'mock'
  const [address, setAddress] = useState(state.user.rootAddress ?? '')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The wallet the person picked; reused for face verification and the step-2 approval.
  const [active, setActive] = useState<{ name: string; provider: EIP1193Provider } | null>(startWallet ? { name: 'your wallet', provider: startWallet } : null)
  // Set when the address they gave isn't a verified GoodDollar identity.
  const [unverified, setUnverified] = useState<{ address: string; fromWallet: boolean } | null>(null)
  // Set when this wallet already belongs to another Jara account (new phone, cleared browser).
  const [linked, setLinked] = useState<string | null>(null)
  const step = state.user.rootAddress ? 2 : 1

  useEffect(() => {
    const sp = new URLSearchParams(window.location.search)
    if (sp.has('fv')) {
      window.history.replaceState(null, '', '/app')
      flash('Welcome back! Connect the same wallet again to finish.')
    }
  }, [flash])

  const act = async (label: string, fn: () => Promise<void>) => {
    setBusy(label)
    setError(null)
    try {
      await fn()
    } catch (err) {
      if (err instanceof ApiError && err.code === 'wallet_linked') {
        setLinked(address || state.user.rootAddress || '')
        return
      }
      setError(walletErrorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  const submitRoot = async (addr: string, fromWallet: boolean) => {
    try {
      setState(await api<State>('/api/onboard', { action: 'root', address: addr }))
      setUnverified(null)
    } catch (err) {
      if (err instanceof ApiError && err.code === 'not_verified') {
        setUnverified({ address: addr, fromWallet })
        return
      }
      if (err instanceof ApiError && err.code === 'wallet_linked') {
        setLinked(addr)
        return
      }
      throw err
    }
  }

  const pickWallet = (name: string, getProvider: () => Promise<EIP1193Provider>) =>
    act('wallet', async () => {
      const provider = await getProvider()
      const addr = await requestAddress(provider)
      setActive({ name, provider })
      setAddress(addr)
      await submitRoot(addr, true)
    })

  const verifyFace = () =>
    act('verify', async () => {
      if (!active || !unverified) return
      const link = await faceVerificationLink(active.provider, unverified.address as `0x${string}`, `${window.location.origin}/app?fv=1`)
      window.location.href = link
    })

  const approve = (provider: EIP1193Provider) =>
    act('approve', async () => {
      if (mock) {
        setState(await api<State>('/api/onboard', { action: 'check' }))
        return
      }
      const wallet = createWalletClient({ chain: celo, transport: custom(provider) })
      const [account] = await wallet.requestAddresses()
      if (account.toLowerCase() !== state.user.rootAddress?.toLowerCase()) {
        throw new Error(
          `This wallet is ${short(account)}, but only your verified GoodDollar account ${short(state.user.rootAddress ?? '')} can approve. Switch accounts, or use GoodDollar’s connect tool below.`,
        )
      }
      await wallet.switchChain({ id: celo.id }).catch(() => wallet.addChain({ chain: celo }))
      const hash = await wallet.writeContract({
        account,
        address: IDENTITY,
        abi: CONNECT_ABI,
        functionName: 'connectAccount',
        args: [state.user.agentAddress as `0x${string}`],
      })
      // Second approval: let Jara spend from their own wallet, so G$ never has to move and they never need CELO.
      if (state.config.treasury) {
        try {
          flash('Linked! Now set your spending limit…')
          await setSpendingLimit(provider, state.config.treasury, state.config.limitGd)
        } catch {
          flash('Skipped the spending limit. You can turn it on later in your profile.')
        }
      }
      flash('Approved! Waiting for Celo…')
      for (let i = 0; i < 12; i++) {
        await new Promise((r) => setTimeout(r, 2500))
        try {
          setState(await api<State>('/api/onboard', { action: 'check' }))
          return
        } catch {
          /* not mined yet */
        }
      }
      throw new Error(`Still waiting for ${hash.slice(0, 10)}… Tap "Check again" in a moment.`)
    })

  // Phone logins leave the page and come back: carry on where they were.
  useEffect(() => {
    if (state.user.rootAddress) return
    if (startWallet) {
      // Next tick: carry on with the wallet they connected on the welcome screen.
      void Promise.resolve().then(() => pickWallet('your wallet', async () => startWallet))
      return
    }
    if (mock) return
    void resumeWallet().then((provider) => {
      if (provider) pickWallet('your wallet', async () => provider)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once, on arrival
  }, [])

  const connectButton = (label: string, onClick: () => void) => (
    <button
      onPointerEnter={prewarmWallet}
      onPointerDown={prewarmWallet}
      onClick={onClick}
      disabled={!!busy}
      className="app-button justify-center bg-forest text-cream hover:bg-forest-soft disabled:opacity-60 min-h-12 text-sm"
    >
      {label}
    </button>
  )

  return (
    <main className="mx-auto grid max-w-xl gap-6 px-4 py-10">
      <div>
        <p className="text-[11px] font-bold tracking-[0.14em] text-forest/70 uppercase">Setup · step {step} of 3</p>
        <h1 className="mt-2 text-4xl leading-none font-semibold tracking-[-0.045em] sm:text-5xl">
          {state.user.name ? `${state.user.name}, let's` : "Let's"} connect your GoodDollar.
        </h1>
      </div>

      <Step n={1} title="Your GoodDollar account" done={step > 1} active={step === 1}>
        {step === 1 ? (
          <div className="grid gap-3">
            <p className="font-medium text-ink/75">Connect any wallet. If it isn’t verified on GoodDollar yet, we’ll help you verify it.</p>

            {linked ? (
              <div className="grid gap-3 rounded-2xl border border-ink/8 bg-[#faf4dc] p-4">
                <p className="font-bold">Welcome back! {short(linked)} already has a Jara account.</p>
                <p className="text-[15px] font-medium text-ink/75">
                  Sign one message with this wallet to open it. It’s free and moves no money; it just proves the wallet is yours.
                </p>
                <WalletActionButton
                  provider={active?.provider}
                  disabled={!!busy}
                  label={busy === 'signin' ? 'Sign in your wallet…' : 'Sign back in with my wallet'}
                  onProvider={(provider) =>
                    act('signin', async () => {
                      setState(await signInWithWallet(provider))
                      flash('Welcome back 👋')
                    })
                  }
                  onError={(err) => setError(walletErrorMessage(err))}
                />
                <p className="text-sm font-semibold text-ink/60">Started on Telegram? Open Jara from the link in your Jara chat instead.</p>
                <button onClick={() => void switchWallet().then(() => setLinked(null))} className="text-left text-sm font-bold text-forest underline">
                  Use a different wallet
                </button>
              </div>
            ) : unverified ? (
              <div className="grid gap-3 rounded-2xl border border-ink/8 bg-[#faf4dc] p-4">
                <p className="font-bold">{short(unverified.address)} isn’t verified on GoodDollar yet.</p>
                <p className="text-[15px] font-medium text-ink/75">
                  GoodDollar needs a one-time face check so each person claims once. It’s free and takes about 2 minutes. Your face stays private: only a
                  “verified” mark goes on-chain.
                </p>
                {unverified.fromWallet && active ? (
                  <button
                    onClick={verifyFace}
                    disabled={!!busy}
                    className="app-button justify-center bg-forest text-cream hover:bg-forest-soft disabled:opacity-60 min-h-12 text-sm"
                  >
                    {busy === 'verify' ? 'Sign the message in your wallet…' : 'Verify this wallet →'}
                  </button>
                ) : (
                  <a
                    href="https://wallet.gooddollar.org"
                    target="_blank"
                    rel="noreferrer"
                    className="app-button justify-center bg-forest text-cream hover:bg-forest-soft disabled:opacity-60 min-h-12 text-center text-sm"
                  >
                    Verify in GoodWallet →
                  </a>
                )}
                <p className="text-sm font-semibold text-ink/60">
                  Already verified with a different wallet? Tap “Try another wallet” and connect that one instead.
                </p>
                <button onClick={() => void switchWallet().then(() => setUnverified(null))} className="text-left text-sm font-bold text-forest underline">
                  Try another wallet
                </button>
              </div>
            ) : (
              <div className="grid gap-2">
                {connectButton(busy === 'wallet' ? 'Connecting…' : 'Connect wallet', () => pickWallet('your wallet', getWalletProvider))}
                {busy === 'wallet' && <button type="button" onClick={cancelConnect} className="text-center text-sm font-semibold text-ink/55 underline">Stuck? Cancel</button>}
                <p className="text-center text-sm font-semibold text-ink/55">Google or email, MetaMask, or any wallet.</p>
              </div>
            )}

            {mock && (
              <button
                onClick={() => act('root', () => submitRoot('0x1111111111111111111111111111111111111111', false))}
                className="text-left text-sm font-bold text-forest underline"
              >
                Demo: use a test address
              </button>
            )}
            {error && <p className="rounded-xl bg-[#fcf0e7] px-4 py-3 text-sm font-semibold text-ink">{error}</p>}
          </div>
        ) : (
          <p className="font-mono text-sm font-bold">{short(state.user.rootAddress ?? '')} <Icon name="check" className="inline h-4 w-4 text-forest" strokeWidth={3} /></p>
        )}
      </Step>

      <Step n={2} title="Let Jara claim for you" done={false} active={step === 2}>
        {step === 2 && (
          <div className="grid gap-3">
            <p className="font-medium text-ink/75">
              Approve two quick things in your wallet: link Jara to your GoodDollar account so it can claim your daily G$, and let it spend up to G$ {gdFmt(state.config.limitGd)} from your wallet for bills and AI. Existing G$ stays in your wallet until spent. Daily claims go into your Jara-managed wallet. You can withdraw claimed G$ and cancel the spending limit any time.
            </p>
            <div className="rounded-xl border border-dashed border-ink/15 bg-[#f7f7f2] px-4 py-3">
              <p className="text-[11px] font-bold tracking-[0.12em] text-ink/50 uppercase">Your jar address</p>
              <p className="font-mono text-sm font-bold break-all">{state.user.agentAddress}</p>
            </div>
            {mock ? (
              <button
                onClick={() => approve({} as EIP1193Provider)}
                disabled={!!busy}
                className="app-button justify-center bg-forest text-cream hover:bg-forest-soft disabled:opacity-60 min-h-12 text-sm"
              >
                {busy === 'approve' ? 'Waiting…' : 'Approve (demo)'}
              </button>
            ) : active ? (
              <button
                onClick={() => approve(active.provider)}
                disabled={!!busy}
                className="app-button justify-center bg-forest text-cream hover:bg-forest-soft disabled:opacity-60 min-h-12 text-sm"
              >
                {busy === 'approve' ? 'Waiting for approval…' : `Approve in ${active.name}`}
              </button>
            ) : (
              connectButton(busy === 'wallet' ? 'Connecting…' : 'Connect wallet to approve', () =>
                act('wallet', async () => {
                  const provider = await getWalletProvider()
                  await requestAddress(provider)
                  setActive({ name: 'your wallet', provider })
                }),
              )
            )}
            {error && <p className="rounded-xl bg-[#fcf0e7] px-4 py-3 text-sm font-semibold text-ink">{error}</p>}
            {!mock && (
              <>
                <button
                  onClick={() => act('check', async () => setState(await api<State>('/api/onboard', { action: 'check' })))}
                  disabled={!!busy}
                  className="app-button-secondary justify-center disabled:opacity-60"
                >
                  {busy === 'check' ? 'Checking…' : 'I approved — check again'}
                </button>
                <a href="https://h3n3kp.csb.app/" target="_blank" rel="noreferrer" className="text-sm font-bold text-forest underline">
                  Wallet not working here? Use GoodDollar&apos;s connect tool and paste your jar address →
                </a>
              </>
            )}
          </div>
        )}
      </Step>

      <Step n={3} title="Choose where Jara reaches you" done={false} active={false}>
        <p className="font-medium text-ink/60">Right after connecting: keep everything in your browser, or add Telegram for morning updates. Your choice, and you can change it later.</p>
      </Step>
    </main>
  )
}

function Step({ n, title, done, active, children }: { n: number; title: string; done: boolean; active: boolean; children: React.ReactNode }) {
  return (
    <section
      className={`rounded-[22px] border border-ink/8 p-5 transition ${active ? 'bg-white shadow-sm' : 'bg-white/60 opacity-70'} ${done ? 'bg-[#edf2e8] opacity-100' : ''}`}
    >
      <div className="mb-3 flex items-center gap-3">
        <span className={`grid h-9 w-9 place-items-center rounded-full text-sm font-bold ${done ? 'bg-forest text-cream' : 'bg-[#edf2e8] text-forest'}`}>
          {done ? <Icon name="check" className="h-4 w-4" strokeWidth={3} /> : n}
        </span>
        <h2 className="text-lg font-bold tracking-tight">{title}</h2>
      </div>
      {children}
    </section>
  )
}

// ---------- dashboard ----------

function greeting() {
  const h = new Date().getHours()
  return h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening'
}

type Lane = 'save' | 'pay' | 'rewards' | 'ai'

function ago(ts: number | null) {
  if (!ts) return 'not yet'
  const m = Math.round((Date.now() - ts) / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`
}

function Dashboard({ state, setState, flash, onProfile }: { state: State; setState: (s: State) => void; flash: (t: string) => void; onProfile: () => void }) {
  const [tab, setTab] = useState<DashboardView>(dashboardView)
  useEffect(() => {
    const update = () => setTab(dashboardView())
    window.addEventListener('hashchange', update)
    window.addEventListener('popstate', update)
    return () => {
      window.removeEventListener('hashchange', update)
      window.removeEventListener('popstate', update)
    }
  }, [])
  const navigate = (view: DashboardView) => {
    window.history.pushState(null, '', `#${view}`)
    setTab(view)
    window.scrollTo({ top: 0, behavior: 'instant' })
  }
  const [editing, setEditing] = useState<JarView | null>(null)
  const [paying, setPaying] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [lastSteps, setLastSteps] = useState<{ lane: Lane; text: string }[] | null>(null)
  const { snapshot: snap } = state
  const mock = state.config.chainMode === 'mock'

  const run = async (label: string, fn: () => Promise<void>) => {
    setBusy(label)
    try {
      await fn()
    } catch (err) {
      flash(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setBusy(null)
    }
  }

  const runAgent = () =>
    run('agent', async () => {
      const r = await api<{ steps: { lane: Lane; text: string }[]; message: string; state: State }>('/api/agent/run', {})
      setState(r.state)
      setLastSteps(r.steps)
      flash(r.steps.length ? `Jara handled ${r.steps.length} thing${r.steps.length > 1 ? 's' : ''}` : 'All quiet — nothing needed doing')
    })

  const headings: Record<DashboardView, { title: string; description: string }> = {
    overview: { title: `${greeting()}${state.user.name ? `, ${state.user.name}` : ''}.`, description: 'A little G$. A little closer to your goals.' },
    automations: { title: 'Let Jara take care of it.', description: 'Your daily claims, recurring jobs, and the work happening for you.' },
    rewards: { title: 'Small habits. Extra G$.', description: 'Keep showing up. Jara collects the rewards you qualify for.' },
    chat: { title: 'A little help from Jara.', description: 'Ask about your money, check your jars, or plan your next payment.' },
    guide: { title: 'Make yourself at home.', description: 'A few simple steps to get more from your GoodDollar.' },
  }

  return (
    <div className="dashboard-shell">
      <DashboardNav active={tab} onSelect={navigate} onWallet={onProfile} />
      <main id="dashboard-content" className="dashboard-main">
        <div className="dashboard-heading">
          <div>
            <p className="mb-2 text-[11px] font-bold tracking-[0.16em] text-forest/60 uppercase">{tab === 'overview' ? 'Your everyday, a little easier' : tab === 'chat' ? 'Ask Jara' : tab === 'guide' ? 'Getting started' : tab}</p>
            <h1 className="text-[28px] leading-tight font-bold tracking-[-0.045em] sm:text-[34px]">{headings[tab].title}</h1>
            <p className="mt-2 text-sm leading-relaxed text-ink/55">{headings[tab].description}</p>
          </div>
          <div className="lg:hidden"><button onClick={() => navigate('guide')} className="app-button-secondary text-xs">Getting started</button></div>
          <div className="hidden items-center gap-2 rounded-full border border-ink/10 bg-white px-3.5 py-2 text-xs font-semibold lg:flex"><Icon name="flame" className="h-4 w-4 text-mandarin" /> {state.user.streak}-day streak</div>
        </div>

        <div hidden={tab !== 'overview'}>
          <div className="overview-grid">
            <div className="grid min-w-0 content-start gap-6">
              <BalanceBar state={state} onProfile={onProfile} onPay={state.config.billsLive ? () => setPaying(true) : undefined} />
              <section className="app-card">
                <JarShelf jars={snap.jars} onEdit={setEditing} />
                <BudgetTransfer state={state} setState={setState} flash={flash} />
              </section>
              <section className="app-card overflow-hidden">
                <div className="flex items-center justify-between gap-3 px-5 pt-5 pb-4 sm:px-6">
                  <div><h2 className="text-lg font-bold tracking-tight">Recent activity</h2><p className="mt-1 text-xs text-ink/50">Your claims, payments, and budget moves.</p></div>
                  <Icon name="chart" className="h-5 w-5 text-forest/40" />
                </div>
                <AgentLog items={state.activity} chainMode={state.config.chainMode} />
              </section>
            </div>
            <aside className="grid min-w-0 content-start gap-5">
              <AgentPanel state={state} busy={busy === 'agent'} onRun={runAgent} lastSteps={lastSteps} />
              <AiLaunch state={state} />
              <div className="rounded-2xl border border-dashed border-forest/20 p-5">
                <div className="flex items-center gap-2 text-sm font-bold text-forest"><Icon name="chat" className="h-4 w-4" /> Need a hand?</div>
                <p className="mt-2 text-sm leading-relaxed text-ink/55">“What’s in my jars?” is a good place to start.</p>
                <button onClick={() => navigate('chat')} className="mt-3 inline-flex min-h-9 items-center gap-2 text-sm font-bold text-forest">Ask Jara <Icon name="arrow" className="h-4 w-4" /></button>
              </div>
              {state.user.hasPending && <button onClick={() => navigate('chat')} className="app-card p-5 text-left text-sm font-bold text-forest">You have a payment to review →</button>}
            </aside>
          </div>
        </div>
        <div hidden={tab !== 'automations'} className="space-y-6">
          <div className="grid items-start gap-6 xl:grid-cols-[minmax(0,1fr)_310px]">
            <AgentJobs state={state} setState={setState} flash={flash} />
            <div className="app-card p-6"><Icon name="jar" className="h-8 w-8 text-forest" /><h2 className="mt-4 text-lg font-bold">Your budgets set the limits.</h2><p className="mt-2 text-sm leading-relaxed text-ink/60">Paid jobs use your AI jar. Bill payments use their matching jar. Jara won’t borrow from another jar to finish a job.</p><button onClick={() => navigate('overview')} className="mt-4 text-sm font-bold text-forest">Manage your jars →</button></div>
          </div>
        </div>
        <div hidden={tab !== 'rewards'} className="max-w-3xl"><RewardsCard state={state} flash={flash} /></div>
        <div hidden={tab !== 'chat'} className="mx-auto max-w-3xl"><Chat state={state} setState={setState} flash={flash} /></div>
        <div hidden={tab !== 'guide'} className="max-w-3xl"><GettingStarted state={state} setState={setState} flash={flash} onPay={state.config.billsLive ? () => setPaying(true) : undefined} /></div>

      {mock && <DemoControls run={run} setState={setState} rate={snap.ngnPerGd} onRunAgent={runAgent} />}

      {paying && <PayBillSheet state={state} setState={setState} flash={flash} onClose={() => setPaying(false)} onEditLight={() => { setPaying(false); setEditing(snap.jars.find((j) => j.kind === 'light') ?? null) }} />}

      {editing && (
        <JarSheet
          jar={editing}
          onClose={() => setEditing(null)}
          onSave={async (patch) => {
            try {
              setState(await api<State>('/api/jars', { kind: editing.kind, ...patch }))
              setEditing(null)
              flash(`${editing.label} jar saved`)
            } catch (err) {
              flash(err instanceof Error ? err.message : 'Could not save')
            }
          }}
        />
      )}
      </main>
    </div>
  )
}

function AgentPanel({ state, busy, onRun, lastSteps }: { state: State; busy: boolean; onRun: () => void; lastSteps: { lane: Lane; text: string }[] | null }) {
  const latestClaim = state.activity.find((a) => a.type === 'claim' && a.status === 'done')
  return (
    <section className="app-card p-5 sm:p-6">
      <div className="flex items-center justify-between gap-2">
        <span className="grid h-10 w-10 place-items-center rounded-xl bg-[#edf2e8] text-forest"><Icon name="bot" className="h-5 w-5" strokeWidth={1.8} /></span>
        <span className="flex items-center gap-1.5 rounded-full bg-[#edf2e8] px-2.5 py-1 text-[11px] font-bold text-forest"><span className={`h-1.5 w-1.5 rounded-full bg-forest ${busy ? 'animate-pulse' : ''}`} /> {busy ? 'Working' : 'Connected'}</span>
      </div>
      <h2 className="mt-5 text-xl font-bold tracking-tight">A little less on your plate.</h2>
      <p className="mt-2 text-sm leading-relaxed text-ink/55">Jara checks for your daily G$ and handles the jobs you’ve switched on.</p>
      <div className="my-5 space-y-3 border-y border-ink/8 py-4 text-xs">
        <div className="flex justify-between gap-2"><span className="text-ink/50">Last check-in</span><span className="font-semibold">{ago(state.user.lastRunAt)}</span></div>
        <div className="flex justify-between gap-2"><span className="text-ink/50">Latest claim</span><span className="font-semibold">{latestClaim ? ago(latestClaim.createdAt) : 'Waiting for first claim'}</span></div>
      </div>
      <button onClick={onRun} disabled={busy} className="app-button-secondary w-full justify-center disabled:opacity-60"><Icon name="undo" className="h-4 w-4" /> {busy ? 'Checking…' : 'Check in now'}</button>
      {lastSteps && <div role="status" className="mt-4 rounded-xl bg-[#edf2e8] p-3 text-xs leading-relaxed text-forest">{lastSteps.length ? <ul className="space-y-2">{lastSteps.map((step, i) => <li key={i}>{step.text}</li>)}</ul> : 'All caught up. Nothing needs doing right now.'}</div>}
    </section>
  )
}

function JarShelf({ jars, onEdit }: { jars: JarView[]; onEdit: (j: JarView) => void }) {
  return (
    <div className="p-5 sm:p-6">
      <div className="flex items-start justify-between gap-3">
        <div><h2 className="text-lg font-bold tracking-tight">Your jars</h2><p className="mt-1 text-xs leading-relaxed text-ink/50">One balance, a budget for each part of your day.</p></div>
        <span className="rounded-full bg-[#f4f5ef] px-2.5 py-1 text-[10px] font-bold tracking-wider text-ink/50 uppercase">Budgets</span>
      </div>
      <div className="mt-5 grid grid-cols-2 gap-3 sm:grid-cols-4">
        {jars.map((j) => (
          <button key={j.kind} onClick={() => onEdit(j)} className={`jar-budget jar-budget-${j.kind} group`} aria-label={`Edit ${j.label} jar, G$ ${gdFmt(j.balanceGd)}`}>
            <div className="flex items-center justify-between"><span className="text-xs font-bold">{j.label === 'AI' ? 'Jara AI' : j.label}</span><span className="text-ink/35 transition group-hover:text-forest">↗</span></div>
            <div className="flex justify-center py-4"><Jar pct={j.pct} color={JAR_COLOR[j.kind]} lid={JAR_LID[j.kind]} className="h-[92px] transition group-hover:-translate-y-1" label={{ icon: JAR_ICON[j.kind], text: j.label }} /></div>
            <p className="text-base font-bold tracking-tight tabular-nums">G$ {gdFmt(j.balanceGd)}</p>
            <p className="mt-0.5 text-[11px] text-ink/50">≈ {formatNgn(j.balanceNgn)}</p>
            <div className="mt-3 h-1 overflow-hidden rounded-full bg-ink/8"><div className="h-full rounded-full bg-forest/60" style={{ width: `${Math.max(0, Math.min(j.pct, 100))}%` }} /></div>
            <p className="mt-2 text-[10px] leading-relaxed text-ink/55">{j.kind === 'ai' ? 'For ideas & answers' : j.dueAt ? `Due ${new Date(j.dueAt).toLocaleDateString('en-NG', { day: 'numeric', month: 'short' })}` : j.autoPay ? 'Automatic payments on' : 'Set a goal →'}</p>
          </button>
        ))}
      </div>
    </div>
  )
}

const TRANSFER_ABI = [
  { type: 'function', name: 'transfer', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] },
] as const

/** Available spending and its budget allocation, shown together without double counting. */
function BalanceBar({ state, onProfile, onPay }: { state: State; onProfile: () => void; onPay?: () => void }) {
  const snap = state.snapshot
  const allocated = snap.jars.reduce((total, jar) => total + jar.balanceGd, 0)
  return (
    <section className="balance-card">
      <div className="relative z-10">
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs font-semibold text-cream/65">Available to spend</p>
          <button onClick={onProfile} className="inline-flex min-h-9 items-center gap-1.5 text-xs font-semibold text-cream/80">Wallet details <Icon name="arrow" className="h-3.5 w-3.5" /></button>
        </div>
        <p className="mt-3 text-[44px] leading-none font-semibold tracking-[-0.05em] tabular-nums sm:text-[56px]"><span className="mr-2 text-[24px] font-medium tracking-normal text-crest sm:text-[30px]">G$</span>{gdFmt(snap.totalGd)}</p>
        <p className="mt-3 text-sm text-cream/55">≈ {formatNgn(Math.floor(snap.totalGd * snap.ngnPerGd))}</p>
        <div className="mt-6 flex flex-wrap gap-2.5">
          {onPay && <button onClick={onPay} className="app-button bg-crest text-ink hover:bg-crest-soft"><Icon name="arrow" className="h-4 w-4 -rotate-45" /> Pay a bill</button>}
          <button onClick={onProfile} className="app-button border border-cream/20 bg-cream/10 text-cream hover:bg-cream/15"><Icon name="coins" className="h-4 w-4" /> Manage wallet</button>
        </div>
      </div>
      <div className="relative z-10 mt-6 grid grid-cols-2 gap-4 border-t border-cream/15 pt-5">
        <div><p className="text-[11px] text-cream/55">Assigned to jars</p><p className="mt-1 text-base font-semibold tabular-nums">G$ {gdFmt(allocated)}</p></div>
        <div><p className="text-[11px] text-cream/55">Unassigned</p><p className="mt-1 text-base font-semibold tabular-nums">G$ {gdFmt(snap.freeGd)}</p></div>
      </div>
    </section>
  )
}

/** Profile: totals, the Jara wallet's gas, and the person's own GoodDollar wallet. */
function ProfileSheet({ state, setState, flash, onClose, onSignOut }: { state: State; setState: (s: State) => void; flash: (t: string) => void; onClose: () => void; onSignOut: () => void }) {
  const dialogRef = useSheetDialog(onClose)
  const snap = state.snapshot
  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/50 backdrop-blur-[2px] sm:items-center sm:p-4" onClick={onClose}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Your wallet" tabIndex={-1} onClick={(e) => e.stopPropagation()} className="animate-pop max-h-[92dvh] w-full max-w-md overflow-y-auto rounded-t-[1.75rem] bg-[#fcfcf8] sm:rounded-[1.75rem] sm:border sm:border-ink/10 sm:shadow-xl">
        <div className="flex items-center gap-4 border-b border-ink/8 bg-white px-6 py-5 text-ink">
          <span className="grid h-12 w-12 place-items-center rounded-full bg-forest text-lg font-bold text-crest">{(state.user.name ?? 'J').slice(0, 1).toUpperCase()}</span>
          <div className="flex-1">
            <h3 className="text-xl font-bold tracking-tight">{state.user.name ?? 'Your profile'}</h3>
            <p className="text-sm text-ink/50 tabular-nums">
              G$ {gdFmt(snap.totalGd)} available · {formatNgn(Math.floor(snap.totalGd * snap.ngnPerGd))}
            </p>
          </div>
          <button onClick={onClose} className="grid h-9 w-9 place-items-center rounded-full bg-[#f4f5ef] text-ink/60 hover:bg-[#edf2e8] hover:text-forest" aria-label="Close">
            <Icon name="x" className="h-4 w-4" strokeWidth={3} />
          </button>
        </div>
        <div className="grid gap-5 p-5">
          {state.config.chainMode === 'mock' && <div className="rounded-2xl bg-white p-5"><p className="font-bold">Your demo wallet</p><p className="mt-2 text-sm leading-relaxed text-ink/60">This preview uses simulated G$. Explore your jars and try a budget move. No real wallet is connected.</p></div>}
          {state.config.chainMode !== 'mock' && <SpendingCard state={state} setState={setState} flash={flash} />}
          {state.config.chainMode !== 'mock' && snap.mode === 'jar' && <GasCard state={state} setState={setState} flash={flash} />}
          {state.config.chainMode !== 'mock' && snap.mode === 'jar' && <WalletCard state={state} setState={setState} flash={flash} />}
          <div className="app-card p-5">
            <p className="text-sm font-semibold">Sign out</p>
            <p className="mt-1 text-sm leading-relaxed text-ink/55">
              Signs you out on this device and disconnects your wallet. Your jars keep working and Jara keeps claiming for you. Connect the same wallet to come back.
            </p>
            <button onClick={onSignOut} className="app-button-secondary mt-4 w-full justify-center">
              Sign out &amp; disconnect wallet
            </button>
          </div>
        </div>
      </div>
    </div>
  )
}

/** One button for a wallet action: uses the connected wallet, or opens the Connect modal. */
function WalletActionButton({
  label,
  disabled,
  provider,
  onProvider,
  onError,
}: {
  label: string
  disabled?: boolean
  /** Use this wallet instead of asking (e.g. the one just connected). */
  provider?: EIP1193Provider
  onProvider: (provider: EIP1193Provider) => Promise<void> | void
  onError: (err: unknown) => void
}) {
  return (
    <button
      onPointerEnter={prewarmWallet}
      onPointerDown={prewarmWallet}
      onClick={async () => {
        try {
          await onProvider(provider ?? (await getWalletProvider()))
        } catch (err) {
          onError(err)
        }
      }}
      disabled={disabled}
      className="app-button justify-center bg-forest text-cream hover:bg-forest-soft disabled:opacity-60 min-h-12 text-sm"
    >
      {label}
    </button>
  )
}

/** Spending from their own wallet: the limit, claimed G$, and switching it on or off. */
function SpendingCard({ state, setState, flash }: { state: State; setState: (s: State) => void; flash: (t: string) => void }) {
  const snap = state.snapshot
  const treasury = state.config.treasury
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)


  if (!treasury || !state.user.rootAddress) return null
  const on = snap.mode === 'wallet'

  const limit = (gd: number, done: string) => async (provider: EIP1193Provider) => {
    setBusy('limit')
    setError(null)
    try {
      const { account } = await setSpendingLimit(provider, treasury, gd)
      if (account.toLowerCase() !== state.user.rootAddress?.toLowerCase()) {
        setError(`That was ${short(account)}. Jara spends from your GoodDollar wallet ${short(state.user.rootAddress ?? '')}; switch to it and try again.`)
        return
      }
      setState(await api<State>('/api/wallet', { action: 'refresh' }))
      flash(done)
    } catch (err) {
      setError(walletErrorMessage(err))
    } finally {
      setBusy(null)
    }
  }

  const withdraw = async () => {
    setBusy('withdraw')
    setError(null)
    try {
      setState(await api<State>('/api/wallet', { action: 'withdraw' }))
      flash('Sent to your wallet 🎉')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Could not move your G$')
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="app-card p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h4 className="text-base font-bold tracking-tight">Your GoodDollar wallet</h4>
        <p className="font-mono text-xs font-bold text-ink/50">{short(state.user.rootAddress)}</p>
      </div>
      <p className="mt-2 text-3xl font-semibold tracking-tight tabular-nums">
        {snap.walletGd === null ? 'G$ —' : `G$ ${gdFmt(snap.walletGd)}`}
        {snap.walletGd !== null && <span className="ml-2 text-base font-bold text-ink/50">{formatNgn(Math.floor(snap.walletGd * snap.ngnPerGd))}</span>}
      </p>

      {on ? (
        <>
          <p className="mt-1 text-sm font-semibold text-ink/70">
            Jara pays bills and AI from here, up to <b>G$ {gdFmt(snap.limitLeftGd)}</b> more. Each purchase uses one wallet. Jara covers new payment network fees.
          </p>
          <div className="mt-4 grid gap-2">
            <WalletActionButton
              disabled={!!busy}
              label={busy === 'limit' ? 'Approve in your wallet…' : `Raise limit to G$ ${gdFmt(snap.limitLeftGd + state.config.limitGd)}`}
              onProvider={limit(snap.limitLeftGd + state.config.limitGd, 'Spending limit raised')}
              onError={(err) => setError(walletErrorMessage(err))}
            />
          </div>
          <div className="mt-4 rounded-xl border border-ink/8 bg-[#f7f7f2] px-4 py-3">
            <p className="text-[11px] font-bold tracking-[0.12em] text-ink/50 uppercase">G$ Jara claimed for you</p>
            <p className="text-xl font-semibold tracking-tight tabular-nums">G$ {gdFmt(snap.claimedGd)}</p>
            <p className="text-sm font-semibold text-ink/60">Held in your Jara-managed wallet until spent or withdrawn. Each purchase uses one wallet only.{snap.feesOwedGd > 0 ? ` Network fees so far: G$ ${gdFmt(snap.feesOwedGd)}.` : ''}</p>
            {snap.claimedGd >= 1 && (
              <button onClick={withdraw} disabled={!!busy} className="mt-2 text-sm font-bold text-forest underline disabled:opacity-60">
                {busy === 'withdraw' ? 'Sending…' : 'Send it to my wallet'}
              </button>
            )}
          </div>
          <div className="mt-3">
            <WalletActionButtonLink
              disabled={!!busy}
              label="Turn off spending from my wallet"
              onProvider={limit(0, 'Turned off. Jara won’t take G$ from your wallet.')}
              onError={(err) => setError(walletErrorMessage(err))}
            />
          </div>
        </>
      ) : (
        <>
          <p className="mt-1 text-sm font-semibold text-ink/70">
            Keep your G$ in your own wallet. Jara pays bills and AI straight from it, up to a limit you set, and handles the network fees, so you never need CELO.
          </p>
          <div className="mt-4 grid gap-2">
            <WalletActionButton
              disabled={!!busy}
              label={busy === 'limit' ? 'Approve in your wallet…' : `Let Jara spend up to G$ ${gdFmt(state.config.limitGd)}`}
              onProvider={limit(state.config.limitGd, 'Done! Jara now spends from your wallet.')}
              onError={(err) => setError(walletErrorMessage(err))}
            />
          </div>
        </>
      )}
      {error && <p className="mt-3 rounded-xl bg-[#fcf0e7] px-4 py-3 text-sm font-semibold">{error}</p>}
    </section>
  )
}

/** Same as WalletActionButton, styled as a quiet text link (for "turn off"). */
function WalletActionButtonLink({ label, disabled, onProvider, onError }: {
  label: string
  disabled?: boolean
  onProvider: (provider: EIP1193Provider) => Promise<void> | void
  onError: (err: unknown) => void
}) {
  return (
    <button
      disabled={disabled}
      onClick={async () => {
        try {
          await onProvider(await getWalletProvider())
        } catch (err) {
          onError(err)
        }
      }}
      className="text-sm font-bold text-ink/60 underline disabled:opacity-50"
    >
      {label}
    </button>
  )
}

/** CELO for network fees in the Jara wallet, paid by the person from their own wallet. */
function GasCard({ state, setState, flash }: { state: State; setState: (s: State) => void; flash: (t: string) => void }) {
  const gas = state.snapshot.gas
  const health = gasHealth(gas)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)
  // Enough for about 10 actions at today's fee, rounded up to a tidy amount.
  const suggested = gas ? Math.max(0.1, Math.ceil(gas.perTxCelo * 10 * 10) / 10) : 0.5


  const addGas = async (provider: EIP1193Provider, amount: number) => {
    setBusy('send')
    setError(null)
    try {
      const wallet = createWalletClient({ chain: celo, transport: custom(provider) })
      const [account] = await wallet.requestAddresses()
      await wallet.switchChain({ id: celo.id }).catch(() => wallet.addChain({ chain: celo }))
      const hash = await wallet.sendTransaction({ account, to: state.user.agentAddress as `0x${string}`, value: parseEther(String(amount)) })
      setBusy('confirm')
      await createPublicClient({ chain: celo, transport: http() }).waitForTransactionReceipt({ hash, timeout: 60_000 })
      setState(await api<State>('/api/session'))
      flash('Gas added ⛽ Jara can claim and pay again.')
    } catch (err) {
      const msg = walletErrorMessage(err)
      setError(/insufficient funds|exceeds the balance/i.test(msg) ? `Your wallet doesn’t have ${amount} CELO. Buy a little CELO (e.g. in MiniPay, Valora or an exchange), then try again.` : msg)
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="app-card p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h4 className="text-base font-bold tracking-tight">Network fees (gas)</h4>
        {health && (
          <span className={`rounded-full px-2.5 py-0.5 text-xs font-bold ${health.empty ? 'bg-mandarin text-ink' : health.low ? 'bg-crest text-ink' : 'bg-forest text-cream'}`}>
            {health.empty ? 'Empty' : health.low ? 'Low' : 'Good'}
          </span>
        )}
      </div>
      <p className="mt-1 text-2xl font-semibold tracking-tight tabular-nums">{gas ? `${gas.celo.toFixed(3)} CELO` : '—'}</p>
      <p className="text-sm font-semibold text-ink/65">
        {gas && health
          ? `About ${health.left} action${health.left === 1 ? '' : 's'} left. Each claim or payment costs ~${gas.perTxCelo.toFixed(3)} CELO right now.`
          : 'Could not read your gas balance just now.'}
      </p>
      <p className="mt-2 text-sm font-semibold text-ink/65">
        Celo charges a small fee in CELO each time Jara claims your G$ or pays for something. All your jars share one Jara wallet, so you only top up once, not per jar.
      </p>

      <div className="mt-4 grid gap-2">
        <WalletActionButton
          disabled={!!busy}
          label={busy === 'send' ? 'Approve in your wallet…' : busy === 'confirm' ? 'Confirming on Celo…' : `Add ${suggested} CELO`}
          onProvider={(provider) => addGas(provider, suggested)}
          onError={(err) => setError(walletErrorMessage(err))}
        />
        {error && <p className="rounded-xl bg-[#fcf0e7] px-4 py-3 text-sm font-semibold">{error}</p>}
      </div>

      <div className="mt-4 rounded-xl border border-dashed border-ink/15 bg-[#f7f7f2] px-4 py-3">
        <p className="text-[11px] font-bold tracking-[0.12em] text-ink/50 uppercase">Or send CELO on Celo to your Jara wallet</p>
        <button
          onClick={() => {
            navigator.clipboard.writeText(state.user.agentAddress).then(() => {
              setCopied(true)
              window.setTimeout(() => setCopied(false), 2000)
            }, () => {})
          }}
          className="mt-1 text-left font-mono text-sm font-bold break-all"
        >
          {state.user.agentAddress} <span className="font-sans text-xs font-bold text-forest">{copied ? 'Copied!' : 'Copy'}</span>
        </button>
      </div>
    </section>
  )
}

/** The person's own GoodDollar wallet: shows its G$ and moves it into Jara in one approval. */
function WalletCard({ state, setState, flash }: { state: State; setState: (s: State) => void; flash: (t: string) => void }) {
  const walletGd = state.snapshot.walletGd
  const root = state.user.rootAddress
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [copied, setCopied] = useState(false)


  if (!root) return null
  const max = Math.floor(walletGd ?? 0)

  const deposit = async (provider: EIP1193Provider) => {
    setBusy('send')
    setError(null)
    try {
      const gd = Math.floor(Number(amount))
      if (!gd || gd <= 0) throw new Error('Enter how much G$ to move.')
      if (walletGd !== null && gd > walletGd) throw new Error(`Your wallet has G$ ${gdFmt(walletGd)}.`)
      const wallet = createWalletClient({ chain: celo, transport: custom(provider) })
      const [account] = await wallet.requestAddresses()
      await wallet.switchChain({ id: celo.id }).catch(() => wallet.addChain({ chain: celo }))
      const hash = await wallet.writeContract({
        account,
        address: GD_TOKEN,
        abi: TRANSFER_ABI,
        functionName: 'transfer',
        args: [state.user.agentAddress as `0x${string}`, parseEther(String(gd))],
      })
      setBusy('confirm')
      setState(await api<State>('/api/deposit', { hash }))
      setAmount('')
      flash(`G$ ${gdFmt(gd)} is now in your jars 🎉`)
    } catch (err) {
      const msg = walletErrorMessage(err)
      setError(/insufficient funds|gas/i.test(msg) ? 'Your wallet needs a little CELO for the network fee. Claim G$ once in GoodWallet to get free gas, then try again.' : msg)
    } finally {
      setBusy(null)
    }
  }

  return (
    <section className="app-card p-5">
      <div className="flex items-baseline justify-between gap-3">
        <h4 className="text-base font-bold tracking-tight">Your GoodDollar wallet</h4>
        <p className="font-mono text-xs font-bold text-ink/50">{short(root)}</p>
      </div>
      <p className="mt-2 text-3xl font-semibold tracking-tight tabular-nums">
        {walletGd === null ? 'G$ —' : `G$ ${gdFmt(walletGd)}`}
        {walletGd !== null && <span className="ml-2 text-base font-bold text-ink/50">{formatNgn(Math.floor(walletGd * state.snapshot.ngnPerGd))}</span>}
      </p>
      <p className="mt-1 text-sm font-semibold text-ink/65">
        {max > 0 ? 'Move some into Jara to fill your jars and pay for AI. It stays yours.' : 'No G$ on Celo in this wallet right now. Jara fills your jars from your daily claim.'}
      </p>

      {max > 0 && (
        <div className="mt-4 grid gap-2">
          <div className="flex gap-2">
            <input
              value={amount}
              onChange={(e) => setAmount(e.target.value.replace(/[^\d]/g, ''))}
              inputMode="numeric"
              placeholder="Amount in G$"
              className="min-w-0 flex-1 rounded-xl border border-ink/15 bg-white px-4 py-3 text-sm font-semibold outline-none focus:border-forest"
            />
            <button onClick={() => setAmount(String(max))} className="app-button-secondary justify-center disabled:opacity-60">
              All
            </button>
          </div>
          <WalletActionButton
            disabled={!!busy || !amount}
            label={busy === 'send' ? 'Approve in your wallet…' : busy === 'confirm' ? 'Confirming on Celo…' : 'Move into Jara'}
            onProvider={deposit}
            onError={(err) => setError(walletErrorMessage(err))}
          />
          {error && <p className="rounded-xl bg-[#fcf0e7] px-4 py-3 text-sm font-semibold">{error}</p>}
        </div>
      )}

      <div className="mt-4 rounded-xl border border-dashed border-ink/15 bg-[#f7f7f2] px-4 py-3">
        <p className="text-[11px] font-bold tracking-[0.12em] text-ink/50 uppercase">Or send G$ on Celo to your jar address</p>
        <button
          onClick={() => {
            navigator.clipboard.writeText(state.user.agentAddress).then(() => {
              setCopied(true)
              window.setTimeout(() => setCopied(false), 2000)
            }, () => {})
          }}
          className="mt-1 text-left font-mono text-sm font-bold break-all"
        >
          {state.user.agentAddress} <span className="font-sans text-xs font-bold text-forest">{copied ? 'Copied!' : 'Copy'}</span>
        </button>
        <button
          onClick={async () => {
            setBusy('check')
            try {
              setState(await api<State>('/api/deposit', {}))
              flash('Jars updated')
            } catch (err) {
              setError(err instanceof Error ? err.message : 'Could not check')
            } finally {
              setBusy(null)
            }
          }}
          disabled={!!busy}
          className="mt-2 block text-sm font-bold text-forest underline"
        >
          {busy === 'check' ? 'Checking…' : 'I sent it — update my jars'}
        </button>
      </div>
    </section>
  )
}

function AiLaunch({ state }: { state: State }) {
  const aiBalance = state.snapshot.jars.find((jar) => jar.kind === 'ai')?.balanceGd ?? 0
  return (
    <section className="relative overflow-hidden rounded-[22px] border border-[#e3d9b0] bg-[#f5eccb] p-5 sm:p-6">
      <div className="flex items-center justify-between"><span className="text-[11px] font-bold tracking-widest text-forest/70 uppercase">Meet your study buddy</span><Icon name="sparkle" className="h-6 w-6 text-forest" strokeWidth={1.6} /></div>
      <h2 className="mt-5 text-[25px] leading-tight font-bold tracking-[-0.04em]">Big ideas.<br />A little help.</h2>
      <p className="mt-3 text-sm leading-relaxed text-ink/60">Research a topic, untangle an assignment, or find your next idea.</p>
      <Link href="/app/ai" className="app-button mt-5 w-full justify-center bg-forest text-cream hover:bg-forest-soft">Open Jara AI <Icon name="arrow" className="h-4 w-4" /></Link>
      <p className="mt-3 text-center text-[11px] text-ink/55">G$ {gdFmt(aiBalance)} available in your AI jar</p>
    </section>
  )
}

// ---------- getting started ----------

const REACH_KEY = 'jara:reach'
const readKey = (k: string) => {
  try {
    return window.localStorage.getItem(k)
  } catch {
    return null
  }
}
const writeKey = (k: string, v: string | null) => {
  try {
    if (v === null) window.localStorage.removeItem(k)
    else window.localStorage.setItem(k, v)
  } catch {
    /* private mode: the choice just isn't remembered */
  }
}

function GettingStarted({ state, setState, flash, onPay }: { state: State; setState: (s: State) => void; flash: (t: string) => void; onPay?: () => void }) {
  const [reach, setReach] = useState(() => readKey(REACH_KEY))
  const [linking, setLinking] = useState(false)
  const { user } = state
  const telegramReady = Boolean(user.telegramLink)

  // While the user links Telegram in another tab, notice as soon as it's done.
  useEffect(() => {
    if (!linking || user.telegramLinked) return
    let tries = 0
    const t = window.setInterval(async () => {
      tries++
      try {
        const s = await api<State>('/api/session')
        if (s.user?.telegramLinked) {
          setState(s)
          setLinking(false)
          flash('Telegram connected 🎉 Jara will message you there too.')
        }
      } catch {
        /* keep waiting */
      }
      if (tries > 60) {
        window.clearInterval(t)
        setLinking(false)
      }
    }, 3000)
    return () => window.clearInterval(t)
  }, [linking, user.telegramLinked, setState, flash])

  const bills = state.snapshot.jars.filter((j) => j.kind !== 'ai')
  const steps: { done: boolean; title: string; detail: string; action?: React.ReactNode }[] = [
    { done: true, title: 'Connect your GoodDollar', detail: 'Done. Jara can now claim your daily G$ for you.' },
    {
      done: state.activity.some((a) => a.type === 'claim'),
      title: 'Get your first G$',
      detail: state.activity.some((a) => a.type === 'claim')
        ? 'Jara has started claiming your G$ and sharing it across your jars.'
        : 'Jara claims for you every few hours. Your first G$ will show up in your jars here.',
    },
    {
      done: user.telegramLinked || reach === 'web',
      title: 'Choose where Jara reaches you',
      detail: user.telegramLinked
        ? 'Telegram is connected. Jara messages you there, and everything still shows here too.'
        : reach === 'web'
          ? 'Web only. Everything Jara does shows here in your agent log and chat. You can add Telegram any time.'
          : 'Use Jara here in your browser, or add Telegram for morning updates, drills and receipts. Both work the same.',
      action:
        user.telegramLinked || reach === 'web' ? (
          !user.telegramLinked && telegramReady ? (
            <button onClick={() => { setReach(null); writeKey(REACH_KEY, null) }} className="text-sm font-bold text-forest underline">Add Telegram instead</button>
          ) : null
        ) : (
          <div className="grid gap-2 sm:grid-cols-2">
            <button
              onClick={() => {
                setReach('web')
                writeKey(REACH_KEY, 'web')
                flash('Great, everything stays here in your browser.')
              }}
              className="rounded-2xl bg-white py-3 font-bold ring-1 ring-ink/15 hover:ring-forest/40"
            >
              Keep it on the web
            </button>
            {telegramReady && (
              <a
                href={user.telegramLink!}
                target="_blank"
                rel="noreferrer"
                onClick={() => setLinking(true)}
                className="app-button justify-center bg-forest text-cream hover:bg-forest-soft disabled:opacity-60 text-center"
              >
                Also use Telegram
              </a>
            )}
          </div>
        ),
    },
    {
      done: state.aiRuns.length > 0,
      title: 'Try Jara AI',
      detail: 'Research, assignment help, exam practice, CVs and more, paid with G$ from your AI jar.',
      action: state.aiRuns.length > 0 ? null : <Link href="/app/ai" className="text-sm font-bold text-forest underline">Open Jara AI →</Link>,
    },
    {
      done: state.jobs.exam.on || state.jobs.scout.on,
      title: 'Give Jara a job',
      detail: 'Daily exam drills until your WAEC or JAMB, or an opportunity scout for scholarships and internships.',
      action: state.jobs.exam.on || state.jobs.scout.on ? null : <a href="#automations" className="text-sm font-bold text-forest underline">Choose a job ↓</a>,
    },
    ...(onPay
      ? [
          {
            done: bills.some((j) => j.details.phone || j.details.meterNumber) || state.activity.some((a) => a.type === 'pay'),
            title: 'Pay your first bill',
            detail: 'Airtime, data or prepaid light, paid from your jars. You see the G$ cost before anything is paid.',
            action: <button onClick={onPay} className="text-sm font-bold text-forest underline">Pay a bill →</button>,
          },
        ]
      : []),
  ]
  const left = steps.filter((s) => !s.done).length

  return (
    <section className="app-card p-5 sm:p-7">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="text-lg font-bold tracking-tight">{left ? 'Getting started' : 'You’re all set 🎉'}</h2>
          <p className="mt-1 text-sm font-semibold text-ink/60">{left ? `${steps.length - left} of ${steps.length} done` : 'Your setup is complete. You can revisit these choices any time.'}</p>
        </div>

      </div>
      <ol className="mt-4 grid gap-3">
        {steps.map((st, i) => (
          <li key={st.title} className={`rounded-2xl p-3 ${st.done ? '' : 'bg-white ring-1 ring-ink/10'}`}>
            <div className="flex gap-3">
              <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-sm font-bold ${st.done ? 'bg-forest text-cream' : 'bg-[#f4f5ef] ring-1 ring-ink/15'}`}>
                {st.done ? <Icon name="check" className="h-4 w-4" strokeWidth={3} /> : i + 1}
              </span>
              <div className="min-w-0 flex-1">
                <p className={`font-bold ${st.done ? 'text-ink/50' : ''}`}>{st.title}</p>
                <p className="text-sm font-semibold text-ink/60">{st.detail}</p>
                {st.action && <div className="mt-2">{st.action}</div>}
              </div>
            </div>
          </li>
        ))}
      </ol>
      {linking && !user.telegramLinked && (
        <div className="mt-4 rounded-2xl border border-ink/10 bg-white p-4">
          <p className="font-bold">Linking Telegram…</p>
          <ol className="mt-2 grid gap-1.5 text-sm font-semibold text-ink/70">
            <li>1. Telegram opens a chat with @{user.telegramLink?.match(/t\.me\/([^?]+)/)?.[1] ?? 'the Jara bot'}.</li>
            <li>2. Tap <span className="font-bold text-ink">Start</span> at the bottom of the chat.</li>
            <li>3. Jara replies “You’re linked”. This page updates by itself.</li>
          </ol>
          <p className="mt-3 text-sm font-semibold text-ink/55">
            Telegram is on your phone, not this computer? Copy the link and open it on your phone. It only works once, and only for you.
          </p>
          <button
            onClick={() => navigator.clipboard?.writeText(user.telegramLink!).then(() => flash('Link copied — open it on your phone'), () => flash(user.telegramLink!))}
            className="mt-2 rounded-full bg-[#f4f5ef] px-3 py-1.5 text-sm font-bold ring-1 ring-ink/10"
          >
            Copy my Telegram link
          </button>
        </div>
      )}
    </section>
  )
}

// ---------- sent by Jara ----------

interface SentItem {
  id: number
  kind: 'drill' | 'scout'
  title: string
  output: string
  costGd: number
  createdAt: number
  examHref: string | null
}

/** "1. Title\n   Deadline: …\n   Why: …\n   https://…" blocks from the opportunity scout. */
function parseOpportunities(text: string) {
  return text
    .split(/\n\s*\n/)
    .map((block) => {
      const lines = block.split('\n').map((l) => l.trim()).filter(Boolean)
      const title = (lines[0] ?? '').replace(/^\d+\.\s*/, '')
      return {
        title,
        deadline: lines.find((l) => l.startsWith('Deadline:'))?.replace('Deadline:', '').trim(),
        why: lines.find((l) => l.startsWith('Why:'))?.replace('Why:', '').trim(),
        link: lines.find((l) => /^https:\/\//.test(l)),
      }
    })
    .filter((o) => o.title && o.link)
}

function SentByJara({ refreshKey, openNewest }: { refreshKey: string; openNewest: boolean }) {
  const [items, setItems] = useState<SentItem[] | null>(null)
  const [open, setOpen] = useState<number | null>(null)

  useEffect(() => {
    let live = true
    fetch('/api/agent/sent')
      .then((r) => r.json())
      .then((j: { items?: SentItem[] }) => {
        if (!live || !j.items) return
        setItems(j.items)
        if (openNewest && j.items[0]) setOpen(j.items[0].id)
      })
      .catch(() => null)
    return () => {
      live = false
    }
  }, [refreshKey, openNewest])

  if (!items?.length) return null
  const when = (ts: number) => new Date(ts).toLocaleDateString('en-NG', { weekday: 'short', day: 'numeric', month: 'short' })

  return (
    <div className="mt-5">
      <div className="flex items-baseline justify-between">
        <h3 className="font-bold">Sent by Jara</h3>
        <p className="text-xs font-bold text-ink/45">{items.length} so far</p>
      </div>
      <ul className="mt-2 grid gap-2">
        {items.map((it) => {
          const isOpen = open === it.id
          const opps = it.kind === 'scout' ? parseOpportunities(it.output) : []
          return (
            <li key={it.id} className="overflow-hidden rounded-2xl bg-white ring-1 ring-ink/10">
              <button onClick={() => setOpen(isOpen ? null : it.id)} className="flex w-full items-center gap-3 p-3 text-left" aria-expanded={isOpen}>
                <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-full ${it.kind === 'scout' ? 'bg-mandarin' : 'bg-crest'}`}>
                  <Icon name={it.kind === 'scout' ? 'sparkle' : 'star'} className="h-4 w-4" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate font-bold">{it.kind === 'scout' ? `${opps.length} opportunit${opps.length === 1 ? 'y' : 'ies'} for you` : it.title.replace(/^Daily /, '')}</span>
                  <span className="block text-xs font-semibold text-ink/50">
                    {when(it.createdAt)} · G$ {gdFmt(it.costGd)}
                  </span>
                </span>
                <Icon name="arrow" className={`h-4 w-4 shrink-0 transition ${isOpen ? 'rotate-90' : ''}`} />
              </button>
              {isOpen && (
                <div className="border-t-2 border-ink/10 bg-white p-4">
                  {it.kind === 'scout' ? (
                    <ul className="grid gap-3">
                      {opps.map((o) => (
                        <li key={o.link} className="rounded-xl bg-cream p-3">
                          <p className="leading-snug font-bold">{o.title}</p>
                          {o.deadline && <p className="mt-1 text-sm font-bold text-mandarin-deep">Deadline: {o.deadline}</p>}
                          {o.why && <p className="mt-1 text-sm font-semibold text-ink/65">{o.why}</p>}
                          <a href={o.link} target="_blank" rel="noreferrer" className="mt-2 inline-block rounded-full bg-forest px-3 py-1.5 text-sm font-bold text-cream">
                            Open & apply ↗
                          </a>
                        </li>
                      ))}
                      <li className="text-xs font-semibold text-ink/50">Always apply on the official site, and never pay anyone to apply.</li>
                    </ul>
                  ) : it.examHref ? (
                    <div className="rounded-xl bg-[#edf2e8] p-5">
                      <p className="font-bold">Your full practice session is ready</p>
                      <p className="mt-2 text-sm text-ink/65">20 questions, one at a time. Choose A–D, then review your score and explanations. Your progress is saved as you go.</p>
                      <Link href={it.examHref} className="app-button mt-4 bg-forest text-cream">Open exam prep <Icon name="arrow" className="h-4 w-4" /></Link>
                      <p className="mt-2 text-xs text-ink/50">Already paid for. Resume or retake this paper at no extra cost.</p>
                    </div>
                  ) : (
                    <div className="max-h-[28rem] overflow-y-auto">
                      <Markdown>{it.output}</Markdown>
                      <Link href="/app/exam" className="app-button-secondary mt-3">Start a new full practice session →</Link>
                    </div>
                  )}
                </div>
              )}
            </li>
          )
        })}
      </ul>
    </div>
  )
}

// ---------- proactive jobs ----------

function AgentJobs({ state, setState, flash }: { state: State; setState: (s: State) => void; flash: (t: string) => void }) {
  const { exam, scout, verification } = state.jobs
  const [open, setOpen] = useState<'exam' | 'scout' | null>(null)
  const [busy, setBusy] = useState(false)
  const [examName, setExamName] = useState(exam.exam ?? 'JAMB')
  const [subjects, setSubjects] = useState(exam.subjects.join(', '))
  const [date, setDate] = useState(exam.date ?? '')
  const [interests, setInterests] = useState(scout.interests ?? '')
  const [sent, setSent] = useState<string | null>(null)
  const field = 'w-full rounded-xl border border-ink/15 bg-white px-4 py-3 text-sm font-medium outline-none focus:border-forest'
  const latest = state.aiRuns.find((r) => r.input.startsWith('[agent]'))

  const save = async (body: Record<string, unknown>, done: string) => {
    setBusy(true)
    try {
      const r = await api<{ sent: string | null; state: State }>('/api/agent/jobs', body)
      setState(r.state)
      setSent(r.sent)
      setOpen(null)
      flash(done)
    } catch (err) {
      flash(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setBusy(false)
    }
  }

  const days = verification.daysLeft
  const verifyLine =
    days === null
      ? 'I’ll warn you a week before your GoodDollar face check expires.'
      : days <= 0
        ? 'Your GoodDollar face check has expired. Re-verify in GoodWallet so I can claim again.'
        : `Face check valid for ${days} more day${days === 1 ? '' : 's'}. I’ll warn you a week before it runs out.`

  const row = (on: boolean) => `grid h-8 w-8 shrink-0 place-items-center rounded-full ${on ? 'bg-forest text-cream' : 'bg-[#f4f5ef] ring-1 ring-ink/10'}`

  return (
    <section id="jobs" className="app-card scroll-mt-4 p-5 sm:p-7">
      <h2 className="text-lg font-bold tracking-tight">Jobs Jara does for you</h2>
      <p className="mt-1 text-sm font-semibold text-ink/55">Switch one on and Jara does it on its own, paid from your AI jar.{state.user.telegramLinked ? ' You’ll get each one on Telegram.' : ''}</p>
      <Link href="/app/exam" className="app-button-secondary mt-4"><Icon name="star" className="h-4 w-4" /> Open full-screen exam prep</Link>

      <ul className="mt-4 grid gap-3">
        <li>
          <div className="flex items-center gap-3">
            <span className={row(exam.on)}><Icon name="star" className="h-4 w-4" /></span>
            <div className="min-w-0 flex-1">
              <p className="font-bold">Daily exam prep</p>
              <p className="text-sm font-semibold text-ink/55">
                {exam.on && exam.exam
                  ? `${exam.exam} · ${exam.subjects.join(', ')} · ${exam.daysLeft} day${exam.daysLeft === 1 ? '' : 's'} to go · ${exam.drillsDone} drill${exam.drillsDone === 1 ? '' : 's'} done`
                  : `A full 20-question practice session every morning until your exam. G$ ${exam.priceGd} a day.`}
              </p>
            </div>
            {exam.on ? (
              <button disabled={busy} onClick={() => save({ job: 'exam', on: false }, 'Exam drills off')} className="shrink-0 rounded-full bg-[#f4f5ef] px-3 py-1.5 text-sm font-bold ring-1 ring-ink/10 hover:ring-ink/30">Stop</button>
            ) : (
              <button onClick={() => setOpen(open === 'exam' ? null : 'exam')} className="shrink-0 rounded-full bg-forest px-3 py-1.5 text-sm font-bold text-cream ring-2 ring-ink">Set up</button>
            )}
          </div>
          {open === 'exam' && (
            <form
              className="mt-3 grid gap-2.5 rounded-2xl bg-cream p-3"
              onSubmit={(e) => {
                e.preventDefault()
                save({ job: 'exam', exam: examName, subjects, examDate: date }, 'Exam prep enabled')
              }}
            >
              <select value={examName} onChange={(e) => setExamName(e.target.value)} className={field} aria-label="Exam">
                {exam.options.map((o) => <option key={o}>{o}</option>)}
              </select>
              <input value={subjects} onChange={(e) => setSubjects(e.target.value)} placeholder="Subjects, e.g. Biology, Chemistry, English" className={field} aria-label="Subjects" />
              <label className="grid gap-1 text-sm font-bold text-ink/60">
                Exam date
                <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className={field} required />
              </label>
              <button disabled={busy} className="app-button justify-center bg-forest text-cream hover:bg-forest-soft disabled:opacity-60">
                {busy ? 'Making your first drill…' : `Start · G$ ${exam.priceGd} a day`}
              </button>
            </form>
          )}
        </li>

        <li>
          <div className="flex items-center gap-3">
            <span className={row(scout.on)}><Icon name="sparkle" className="h-4 w-4" /></span>
            <div className="min-w-0 flex-1">
              <p className="font-bold">Opportunity scout</p>
              <p className="text-sm font-semibold text-ink/55">
                {scout.on
                  ? `Looking for: ${scout.interests} · checks every 3 days`
                  : `Real scholarships, internships and fellowships that match you. G$ ${scout.priceGd}, only when it finds some.`}
              </p>
            </div>
            {scout.on ? (
              <button disabled={busy} onClick={() => save({ job: 'scout', on: false }, 'Opportunity scout off')} className="shrink-0 rounded-full bg-[#f4f5ef] px-3 py-1.5 text-sm font-bold ring-1 ring-ink/10 hover:ring-ink/30">Stop</button>
            ) : (
              <button onClick={() => setOpen(open === 'scout' ? null : 'scout')} className="shrink-0 rounded-full bg-forest px-3 py-1.5 text-sm font-bold text-cream ring-2 ring-ink">Set up</button>
            )}
          </div>
          {open === 'scout' && (
            <form
              className="mt-3 grid gap-2.5 rounded-2xl bg-cream p-3"
              onSubmit={(e) => {
                e.preventDefault()
                save({ job: 'scout', interests }, 'Opportunity scout on')
              }}
            >
              <input value={interests} onChange={(e) => setInterests(e.target.value)} placeholder="e.g. engineering scholarships, tech internships" className={field} aria-label="What you’re looking for" />
              <button disabled={busy} className="app-button justify-center bg-forest text-cream hover:bg-forest-soft disabled:opacity-60">
                {busy ? 'Looking now…' : 'Start scouting'}
              </button>
            </form>
          )}
        </li>

        <li className="flex items-center gap-3">
          <span className={row(true)}><Icon name="alert" className="h-4 w-4" /></span>
          <div className="min-w-0 flex-1">
            <p className="font-bold">Verification reminder <span className="text-sm font-bold text-forest">· free, always on</span></p>
            <p className="text-sm font-semibold text-ink/55">{verifyLine}</p>
          </div>
        </li>
      </ul>

      {(latest || sent) && <SentByJara refreshKey={`${latest?.id ?? 0}:${sent ? 1 : 0}`} openNewest={Boolean(sent)} />}
    </section>
  )
}

function RewardsCard({ state, flash }: { state: State; flash: (t: string) => void }) {
  const { rewards, user } = state
  return (
    <section className="app-card p-5 sm:p-7">
      <div className="flex items-baseline justify-between">
        <h2 className="text-lg font-bold tracking-tight">Rewards</h2>
        <p className="font-bold text-forest">G$ {gdFmt(rewards.earnedGd)} earned</p>
      </div>
      <p className="mt-1 text-sm font-semibold text-ink/55">Jara collects these for you automatically.</p>
      <ul className="mt-4 grid gap-2.5">
        {rewards.items.map((r) => (
          <li key={r.title} className="flex items-center gap-3">
            <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-sm font-bold ${r.done ? 'bg-forest text-cream' : 'bg-[#f4f5ef] ring-1 ring-ink/10'}`}>
              <Icon name={r.done ? 'check' : 'star'} className="h-4 w-4" strokeWidth={r.done ? 3 : 2.25} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-2">
                <p className={`truncate font-bold ${r.done ? 'text-ink/45 line-through' : ''}`}>{r.title}</p>
                <span className="shrink-0 text-sm font-bold">+G$ {gdFmt(r.amountGd)}</span>
              </div>
              {!r.done && (
                <div className="mt-1 flex items-center gap-2">
                  <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-ink/10">
                    <div className="h-full rounded-full bg-mandarin" style={{ width: `${Math.max(r.progress * 100, 4)}%` }} />
                  </div>
                  <span className="text-xs font-bold text-ink/45">{r.detail}</span>
                </div>
              )}
            </div>
          </li>
        ))}
      </ul>
      <button
        onClick={() => {
          navigator.clipboard?.writeText(user.inviteLink).then(() => flash('Invite link copied — G$ 1,000 per friend who joins'), () => flash(user.inviteLink))
        }}
        className="mt-4 w-full rounded-2xl bg-cream py-3 text-sm font-bold ring-1 ring-ink/10 hover:ring-ink/30"
      >
        Copy my invite link
      </button>
    </section>
  )
}

function DemoControls({
  run,
  setState,
  rate,
  onRunAgent,
}: {
  run: (label: string, fn: () => Promise<void>) => Promise<void>
  setState: (s: State) => void
  rate: number
  onRunAgent: () => void
}) {
  const [open, setOpen] = useState(false)
  const item = 'rounded-xl bg-cream/10 px-3 py-2 text-left text-sm font-bold hover:bg-cream/20'
  return (
    <div className="fixed right-4 bottom-20 z-40 lg:bottom-6">
      {open ? (
        <div className="animate-pop w-64 rounded-2xl bg-ink p-3 text-cream shadow-[0_12px_32px_rgba(11,31,22,0.4)]">
          <div className="mb-2 flex items-center justify-between">
            <p className="text-xs font-bold tracking-widest text-cream/50 uppercase">Demo controls</p>
            <button onClick={() => setOpen(false)} className="text-cream/50 hover:text-cream" aria-label="Close demo controls">
              <Icon name="x" className="h-4 w-4" strokeWidth={3} />
            </button>
          </div>
          <div className="grid gap-2">
            <button
              onClick={() =>
                run('day', async () => {
                  await api<State>('/api/demo/deposit', { action: 'next-day' })
                  onRunAgent()
                })
              }
              className={item}
            >
              ⏭ Skip to tomorrow (agent runs)
            </button>
            <button onClick={() => run('dep', async () => setState(await api<State>('/api/demo/deposit', { gd: 5000 })))} className={item}>
              ＋ Deposit G$ 5,000
            </button>
          </div>
          <p className="mt-2 text-[11px] font-semibold text-cream/40">
            Simulated G$ · 1 G$ = ₦{rate.toFixed(3)}
          </p>
        </div>
      ) : (
        <button onClick={() => setOpen(true)} className="rounded-full bg-ink px-4 py-2 text-xs font-bold tracking-widest text-cream/80 uppercase shadow-lg hover:text-cream">
          Demo
        </button>
      )}
    </div>
  )
}

// ---------- pay a bill ----------

type BillKindUi = 'airtime' | 'data' | 'light'

function PayBillSheet({
  state,
  setState,
  flash,
  onClose,
  onEditLight,
}: {
  state: State
  setState: (s: State) => void
  flash: (t: string) => void
  onClose: () => void
  onEditLight: () => void
}) {
  const dialogRef = useSheetDialog(onClose)
  const jar = (k: BillKindUi) => state.snapshot.jars.find((j) => j.kind === k)!
  const savedPhone = jar('airtime').details.phone ?? jar('data').details.phone ?? ''
  const light = jar('light').details
  const [kind, setKind] = useState<BillKindUi>('airtime')
  const [amount, setAmount] = useState<number>(100)
  const [custom, setCustom] = useState('')
  const [phone, setPhone] = useState(savedPhone)
  const [network, setNetwork] = useState<string>(detectNetwork(savedPhone.replace(/\D/g, '')) ?? 'mtn')
  const [plans, setPlans] = useState<{ code: string; name: string; amountNgn: number }[] | null>(null)
  const [plan, setPlan] = useState('')
  const [review, setReview] = useState<{ id: string; summary: string; gd: number; amountNgn: number } | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [done, setDone] = useState<string | null>(null)
  const field = 'w-full rounded-xl border border-ink/15 bg-white px-4 py-3 text-sm font-medium outline-none focus:border-forest'
  const presets = kind === 'light' ? [1000, 2000, 3000, 5000] : [100, 200, 500, 1000]
  const value = custom ? Number(custom) : amount

  const onPhone = (v: string) => {
    setPhone(v)
    const n = detectNetwork(v.replace(/\D/g, '').replace(/^234/, '0'))
    if (n && n !== network) {
      setNetwork(n)
      setPlans(null)
      setPlan('')
    }
  }

  useEffect(() => {
    if (kind !== 'data' || plans) return
    let live = true
    fetch(`/api/bills?network=${network}`)
      .then((r) => r.json())
      .then((j: { plans?: { code: string; name: string; amountNgn: number }[]; error?: string }) => {
        if (!live) return
        if (j.plans) setPlans(j.plans)
        else flash(j.error ?? 'Could not load data plans')
      })
      .catch(() => live && flash('Could not load data plans'))
    return () => {
      live = false
    }
  }, [kind, network, plans, flash])

  const act = async (label: string, fn: () => Promise<void>) => {
    setBusy(label)
    try {
      await fn()
    } catch (err) {
      flash(err instanceof Error ? err.message : 'Something went wrong')
    } finally {
      setBusy(null)
    }
  }

  const prepare = () =>
    act('prepare', async () => {
      const chosen = plans?.find((p) => p.code === plan)
      const r = await api<{ id: string; summary: string; gd: number; amountNgn: number }>('/api/bills', {
        action: 'prepare',
        kind,
        amountNgn: kind === 'data' ? chosen?.amountNgn : value,
        phone: kind === 'light' ? undefined : phone,
        network: kind === 'light' ? undefined : network,
        planCode: kind === 'data' ? plan : undefined,
      })
      setReview(r)
    })

  const decide = (confirm: boolean) =>
    act(confirm ? 'pay' : 'cancel', async () => {
      const send = () => api<{ reply: { text: string } }>('/api/bills', { action: confirm ? 'confirm' : 'cancel', actionId: review?.id, response: 'compact' })
      let r: { reply: { text: string } }
      try {
        r = await send()
      } catch (err) {
        if (!confirm || !(err instanceof ApiError) || !err.retryable) throw err
        // Paying can take a while on-chain; if the connection dropped, ask what happened instead of guessing.
        await new Promise((ok) => setTimeout(ok, 4000))
        r = await send()
      }
      // A balance/RPC outage must not hide a completed payment response.
      void api<State | { user: null }>('/api/session').then((s) => { if (s.user) setState(s as State) }).catch(() => {})
      if (!confirm) {
        setReview(null)
        return
      }
      setDone(r.reply.text)
    })

  const canReview =
    kind === 'light' ? Boolean(light.meterNumber) && value > 0 : phone.replace(/\D/g, '').length >= 10 && (kind === 'data' ? Boolean(plan) : value >= 50)

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/50 backdrop-blur-[2px] sm:items-center sm:p-4" onClick={onClose}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Pay a bill" tabIndex={-1} onClick={(e) => e.stopPropagation()} className="animate-pop max-h-[92dvh] w-full max-w-md overflow-y-auto rounded-t-[1.75rem] bg-[#fcfcf8] sm:rounded-[1.75rem] sm:border sm:border-ink/10 sm:shadow-xl">
        <div className="flex items-center justify-between border-b border-ink/8 bg-white px-6 py-5 text-ink">
          <h3 className="text-xl font-bold tracking-tight">Pay a bill</h3>
          <button onClick={onClose} className="grid h-9 w-9 place-items-center rounded-full bg-[#f4f5ef] text-ink/60 hover:bg-[#edf2e8] hover:text-forest" aria-label="Close">
            <Icon name="x" className="h-4 w-4" strokeWidth={3} />
          </button>
        </div>

        {done ? (
          <div className="grid gap-4 p-6">
            <p className="text-base leading-snug font-semibold whitespace-pre-wrap">{done}</p>
            <button onClick={onClose} className="app-button justify-center bg-forest text-cream hover:bg-forest-soft disabled:opacity-60">Close</button>
          </div>
        ) : review ? (
          <div className="grid gap-4 p-6">
            <div className="rounded-2xl border border-ink/10 bg-white p-4">
              <p className="text-sm font-bold tracking-wide text-ink/50 uppercase">You’re paying</p>
              <p className="mt-1 text-lg leading-snug font-bold">{review.summary}</p>
              <p className="mt-2 font-semibold text-ink/60">G$ {gdFmt(review.gd)} from your jars</p>
            </div>
            <div className="grid grid-cols-2 gap-3">
              <button disabled={!!busy} onClick={() => decide(false)} className="rounded-2xl bg-white py-3 font-bold ring-1 ring-ink/15">Cancel</button>
              <button disabled={!!busy} onClick={() => decide(true)} className="app-button justify-center bg-forest text-cream hover:bg-forest-soft disabled:opacity-60">
                {busy === 'pay' ? 'Paying…' : 'Pay it'}
              </button>
            </div>
          </div>
        ) : (
          <div className="grid gap-5 p-6">
            <div className="grid grid-cols-3 gap-2 rounded-2xl bg-[#f4f5ef] p-1">
              {(['airtime', 'data', 'light'] as const).map((k) => (
                <button
                  key={k}
                  onClick={() => {
                    setKind(k)
                    setCustom('')
                    setAmount(k === 'light' ? 1000 : 100)
                  }}
                  className={`rounded-xl py-2.5 text-sm font-semibold capitalize ${kind === k ? 'bg-white text-forest shadow-sm' : 'text-ink/55'}`}
                >
                  {k}
                </button>
              ))}
            </div>

            {kind !== 'light' && (
              <div className="grid gap-2">
                <p className="text-[11px] font-bold tracking-[0.12em] text-ink/50 uppercase">Phone number</p>
                <input value={phone} onChange={(e) => onPhone(e.target.value)} inputMode="tel" placeholder="0803 123 4567" className={field} />
                <div className="grid grid-cols-4 gap-2">
                  {NETWORKS.map((n) => (
                    <button
                      key={n}
                      onClick={() => {
                        setNetwork(n)
                        setPlans(null)
                        setPlan('')
                      }}
                      className={`rounded-xl py-2 text-sm font-semibold ring-1 ${network === n ? 'bg-[#edf2e8] text-forest ring-forest' : 'bg-white ring-ink/10'}`}
                      style={network === n ? { background: NETWORK_INFO[n].brand, color: NETWORK_INFO[n].ink } : undefined}
                    >
                      {NETWORK_INFO[n].label}
                    </button>
                  ))}
                </div>
              </div>
            )}

            {kind === 'light' && (
              <div className="rounded-2xl bg-white p-4 ring-1 ring-ink/10">
                {light.meterNumber ? (
                  <>
                    <p className="font-bold">Meter {light.meterNumber}</p>
                    <p className="text-sm font-semibold text-ink/55">
                      {light.customerName ? `${light.customerName} · ` : ''}
                      {light.disco && (DISCO_INFO as Record<string, { short: string }>)[light.disco] ? (DISCO_INFO as Record<string, { short: string }>)[light.disco].short : light.disco} · {light.meterType ?? 'prepaid'}
                    </p>
                  </>
                ) : (
                  <p className="font-semibold text-ink/70">Add your meter first.</p>
                )}
                <button onClick={onEditLight} className="mt-2 text-sm font-bold text-forest underline">{light.meterNumber ? 'Change meter' : 'Set up my meter'}</button>
              </div>
            )}

            {kind === 'data' ? (
              <div className="grid gap-2">
                <p className="text-[11px] font-bold tracking-[0.12em] text-ink/50 uppercase">Data plan</p>
                {plans === null ? (
                  <p className="font-semibold text-ink/55">Loading {NETWORK_INFO[network as keyof typeof NETWORK_INFO]?.label} plans…</p>
                ) : (
                  <select value={plan} onChange={(e) => setPlan(e.target.value)} className={field}>
                    <option value="">Choose a plan</option>
                    {plans.map((p) => (
                      <option key={p.code} value={p.code}>{p.name} · {formatNgn(p.amountNgn)}</option>
                    ))}
                  </select>
                )}
              </div>
            ) : (
              <div className="grid gap-2">
                <p className="text-[11px] font-bold tracking-[0.12em] text-ink/50 uppercase">Amount</p>
                <div className="grid grid-cols-4 gap-2">
                  {presets.map((p) => (
                    <button
                      key={p}
                      onClick={() => {
                        setAmount(p)
                        setCustom('')
                      }}
                      className={`rounded-xl py-3 text-sm font-semibold ring-1 ${!custom && amount === p ? 'bg-forest text-cream ring-forest' : 'bg-white ring-ink/10 hover:ring-forest/40'}`}
                    >
                      {formatNgn(p)}
                    </button>
                  ))}
                </div>
                <input value={custom} onChange={(e) => setCustom(e.target.value.replace(/\D/g, ''))} inputMode="numeric" placeholder="Other amount (₦)" className={field} />
              </div>
            )}

            <button disabled={!canReview || !!busy} onClick={prepare} className="app-button justify-center bg-forest text-cream hover:bg-forest-soft disabled:opacity-60 min-h-12 text-sm">
              {busy === 'prepare' ? 'Checking…' : 'Review'}
            </button>
            <p className="-mt-2 text-center text-sm font-semibold text-ink/50">You’ll see the G$ cost before anything is paid.</p>
          </div>
        )}
      </div>
    </div>
  )
}

function JarSheet({ jar, onClose, onSave }: { jar: JarView; onClose: () => void; onSave: (p: Record<string, unknown>) => Promise<void> }) {
  const dialogRef = useSheetDialog(onClose)
  const [target, setTarget] = useState(jar.targetNgn)
  const [autoPay, setAutoPay] = useState(jar.autoPay)
  const [phone, setPhone] = useState(jar.details.phone ?? '')
  const [disco, setDisco] = useState(jar.details.disco ?? 'kaduna')
  const [meterType, setMeterType] = useState(jar.details.meterType ?? 'prepaid')
  const [meter, setMeter] = useState(jar.details.meterNumber ?? '')
  const [every, setEvery] = useState<number | null>(jar.everyDays)
  const [saving, setSaving] = useState(false)
  const presets = jar.kind === 'light' ? [2000, 3000, 5000, 10000] : jar.kind === 'data' ? [500, 1000, 1500, 3000] : [200, 500, 1000, 2000]
  const field = 'w-full rounded-xl border border-ink/15 bg-white px-4 py-3 text-sm font-medium outline-none focus:border-forest'

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/50 backdrop-blur-[2px] sm:items-center sm:p-4" onClick={onClose}>
      <div ref={dialogRef} role="dialog" aria-modal="true" aria-label="Edit jar" tabIndex={-1} onClick={(e) => e.stopPropagation()} className="animate-pop max-h-[92dvh] w-full max-w-md overflow-y-auto rounded-t-[1.75rem] bg-[#fcfcf8] sm:rounded-[1.75rem] sm:border sm:border-ink/10 sm:shadow-xl">
        <div className="flex items-center gap-4 border-b border-ink/8 bg-white px-6 py-5 text-ink">
          <Jar pct={jar.pct} color={JAR_COLOR[jar.kind]} lid={JAR_LID[jar.kind]} className="h-16 w-12" />
          <div className="flex-1">
            <h3 className="text-xl font-bold tracking-tight">{jar.label} jar</h3>
            <p className="text-sm text-ink/50">
              {formatNgn(jar.balanceNgn)} saved · {jar.pct}%
            </p>
          </div>
          <button onClick={onClose} className="grid h-9 w-9 place-items-center rounded-full bg-[#f4f5ef] text-ink/60 hover:bg-[#edf2e8] hover:text-forest" aria-label="Close">
            <Icon name="x" className="h-4 w-4" strokeWidth={3} />
          </button>
        </div>

        <div className="grid gap-5 p-6">
          <div>
            <p className="mb-2 text-[11px] font-bold tracking-[0.12em] text-ink/50 uppercase">Save up to</p>
            <div className="grid grid-cols-4 gap-2">
              {presets.map((p) => (
                <button
                  key={p}
                  onClick={() => setTarget(p)}
                  className={`rounded-xl py-2.5 text-sm font-semibold transition ${target === p ? 'bg-forest text-cream' : 'bg-white text-ink ring-1 ring-ink/10 hover:ring-forest/40'}`}
                >
                  {p >= 1000 ? `₦${p / 1000}k` : `₦${p}`}
                </button>
              ))}
            </div>
          </div>

          {jar.kind === 'ai' ? (
            <p className="rounded-2xl bg-white px-4 py-3 text-sm text-ink/65 ring-1 ring-ink/10">
              This jar pays for your AI helpers — research, assignment help, brainstorming, exam practice and more. Jara fills it from your daily G$.
            </p>
          ) : jar.kind === 'light' ? (
            <div className="grid gap-3">
              <p className="text-[11px] font-bold tracking-[0.12em] text-ink/50 uppercase">Your meter</p>
              <select value={disco} onChange={(e) => setDisco(e.target.value)} className={field}>
                {DISCOS.map((d) => (
                  <option key={d} value={d}>
                    {DISCO_INFO[d].short} — {DISCO_INFO[d].region}
                  </option>
                ))}
              </select>
              <div className="grid grid-cols-2 gap-1 rounded-xl bg-[#f4f5ef] p-1">
                {['prepaid', 'postpaid'].map((t) => (
                  <button key={t} onClick={() => setMeterType(t)} className={`rounded-lg py-2 text-sm font-semibold capitalize ${meterType === t ? 'bg-white text-forest shadow-sm' : 'text-ink/55'}`}>
                    {t}
                  </button>
                ))}
              </div>
              <input value={meter} onChange={(e) => setMeter(e.target.value)} inputMode="numeric" placeholder="Meter number" className={field} />
              {jar.details.customerName && <p className="flex items-center gap-1 text-sm font-bold text-forest"><Icon name="check" className="h-4 w-4" strokeWidth={3} /> {jar.details.customerName}</p>}
            </div>
          ) : (
            <div className="grid gap-2">
              <p className="text-[11px] font-bold tracking-[0.12em] text-ink/50 uppercase">Phone number</p>
              <input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" placeholder="0803 123 4567" className={field} />
            </div>
          )}

          {jar.kind !== 'ai' && (
          <>
          <div>
            <p className="mb-2 text-[11px] font-bold tracking-[0.12em] text-ink/50 uppercase">This bill comes round</p>
            <div className="grid grid-cols-4 gap-2">
              {[null, 7, 14, 30].map((d) => (
                <button
                  key={String(d)}
                  onClick={() => setEvery(d)}
                  className={`rounded-xl py-2.5 text-sm font-semibold transition ${every === d ? 'bg-forest text-cream' : 'bg-white ring-1 ring-ink/10 hover:ring-forest/40'}`}
                >
                  {d ? `${d} days` : 'When full'}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-xs font-semibold text-ink/50">Jara tops this jar up before it’s due and pays on time.</p>
          </div>

          <button onClick={() => setAutoPay(!autoPay)} className="flex w-full items-center justify-between rounded-2xl bg-white px-4 py-3 text-left ring-1 ring-ink/10">
            <span>
              <span className="block text-sm font-semibold">Pay automatically</span>
              <span className="text-sm font-semibold text-ink/55">{every ? `Every ${every} days, ${formatNgn(target)}` : `When the jar reaches ${formatNgn(target)}`}</span>
            </span>
            <span className={`relative h-7 w-12 shrink-0 rounded-full transition ${autoPay ? 'bg-forest' : 'bg-ink/15'}`}>
              <span className={`absolute top-1 h-5 w-5 rounded-full bg-cream shadow transition-all ${autoPay ? 'left-6' : 'left-1'}`} />
            </span>
          </button>
          </>
          )}

          <button
            disabled={saving}
            onClick={async () => {
              setSaving(true)
              await onSave(
                jar.kind === 'ai'
                  ? { targetNgn: target }
                  : jar.kind === 'light'
                  ? { targetNgn: target, autoPay, everyDays: every, disco, meterType, meterNumber: meter || undefined }
                  : { targetNgn: target, autoPay, everyDays: every, phone: phone || undefined },
              )
              setSaving(false)
            }}
            className="app-button justify-center bg-forest text-cream hover:bg-forest-soft disabled:opacity-60 min-h-12 w-full text-sm"
          >
            {saving ? (jar.kind === 'light' && meter ? 'Checking meter…' : 'Saving…') : 'Save jar'}
          </button>
        </div>
      </div>
    </div>
  )
}

const ACT_STYLE: Record<string, { icon: IconName; tint: string; sign: '+' | '−' | '' }> = {
  claim: { icon: 'sun', tint: 'bg-crest', sign: '+' },
  deposit: { icon: 'plus', tint: 'bg-crest-soft', sign: '+' },
  reward: { icon: 'star', tint: 'bg-[#f4f5ef] ring-1 ring-ink/15', sign: '+' },
  refund: { icon: 'undo', tint: 'bg-crest-soft', sign: '+' },
  pay: { icon: 'bolt', tint: 'bg-mandarin', sign: '−' },
  move: { icon: 'arrow', tint: 'bg-cream', sign: '' },
  ai: { icon: 'sparkle', tint: 'bg-forest-soft text-cream', sign: '−' },
  agent: { icon: 'jar', tint: 'bg-ink text-cream', sign: '' },
}

function AgentLog({ items, chainMode }: { items: Activity[]; chainMode: string }) {
  if (!items.some((a) => a.type !== 'agent')) return <div className="px-6 py-9 text-center"><Icon name="sun" className="mx-auto mb-3 h-7 w-7 text-forest/40" /><p className="text-sm font-semibold">A fresh start.</p><p className="mt-1 text-xs text-ink/50">Your claims and payments will appear here.</p></div>
  return (
    <ul className="overflow-hidden bg-white">
      {items
        .filter((a) => a.type !== 'agent')
        .slice(0, 10)
        .map((a, i) => {
          const st = ACT_STYLE[a.type] ?? ACT_STYLE.move
          const gd = a.amountWei ? Number(BigInt(a.amountWei) / 10n ** 18n) : null
          return (
            <li key={a.id} className={`flex items-center gap-3 px-5 py-4 sm:px-6 ${i ? 'border-t border-ink/10' : ''}`}>
              <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-full text-base font-bold ${a.status === 'failed' ? 'bg-red-100' : st.tint}`}>
                <Icon name={a.status === 'failed' ? 'alert' : st.icon} className="h-5 w-5" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="text-sm font-semibold">{a.title}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-ink/50">
                  {a.detail ?? ago(a.createdAt)}
                  {['pending', 'refund_pending', 'settling'].includes(a.status) && ' · processing'}
                  {a.txHash && chainMode === 'celo' && (
                    <>
                      {' · '}
                      <a href={`https://celoscan.io/tx/${a.txHash}`} target="_blank" rel="noreferrer" className="underline">
                        receipt
                      </a>
                    </>
                  )}
                </p>
              </div>
              {gd !== null && st.sign && (
                <span className={`shrink-0 text-xs font-bold tabular-nums ${st.sign === '+' ? 'text-forest' : 'text-ink'}`}>
                  {st.sign}G$ {gd.toLocaleString()}
                </span>
              )}
            </li>
          )
        })}
    </ul>
  )
}

// ---------- chat ----------

const CHIPS = ['Help me brainstorm a project', '₦200 airtime for me', 'My rewards', 'What’s in my jars?', 'Buy ₦3000 light']

function Chat({ state, setState, flash }: { state: State; setState: (s: State) => void; flash: (t: string) => void }) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [confirm, setConfirm] = useState<{ id: string; summary: string; gd: number } | null>(state.user.hasPending ? { id: state.user.pendingId ?? '', summary: 'Your last request', gd: 0 } : null)
  const [optimistic, setOptimistic] = useState<string | null>(null)
  const [received, setReceived] = useState<Msg[]>([])
  const sendingRef = useRef(false)
  const messages = [...new Map([...state.messages, ...received].map((m) => [m.id, m])).values()].sort((a, b) => a.id - b.id).slice(-60)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [messages.length, optimistic, sending, confirm])

  const send = async (body: { text?: string; confirm?: boolean }) => {
    if (sendingRef.current) return
    sendingRef.current = true
    setSending(true)
    if (body.text) setOptimistic(body.text)
    if (body.confirm !== undefined) setConfirm(null)
    try {
      const r = await api<{ reply: { text: string; confirm?: { id: string; summary: string; gd: number } }; messages: Msg[] }>('/api/chat', { ...body, response: 'compact', ...(body.confirm !== undefined ? { actionId: confirm?.id } : {}) })
      setReceived(r.messages)
      setConfirm(r.reply.confirm ?? null)
      void api<State | { user: null }>('/api/session').then((s) => { if (s.user) setState(s as State) }).catch(() => {})
    } catch (err) {
      if (body.confirm !== undefined) setConfirm(confirm)
      if (body.text) setText(body.text)
      flash(err instanceof Error ? err.message : 'Could not send')
    } finally {
      sendingRef.current = false
      setOptimistic(null)
      setSending(false)
    }
  }

  const status = 'Your money, jars, and everyday questions'

  return (
    <section className="app-card flex h-[max(480px,calc(100dvh-300px))] max-h-[800px] flex-col overflow-hidden">
      <div className="flex items-center gap-3 bg-forest px-5 py-4 text-cream">
        <div className="relative">
          <span className="grid h-11 w-11 place-items-center rounded-full bg-crest text-ink"><Icon name="jar" className="h-6 w-6" /></span>
          <span className="absolute right-0 bottom-0 h-3 w-3 rounded-full border-2 border-forest bg-mandarin" />
        </div>
        <div>
          <p className="text-lg leading-none font-bold">Jara</p>
          <p className="mt-1 text-xs font-semibold text-cream/60">{status}</p>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 space-y-2.5 overflow-y-auto bg-cream/60 px-4 py-5">
        {messages.length === 0 && !optimistic && (
          <ChatBubble
            me={false}
            text={`Hi${state.user.name ? ` ${state.user.name}` : ''}! I’m your AI agent. ${state.config.billsLive ? 'I save your G$, pay your bills, find you rewards — and your G$ pays for AI help with research, assignments and ideas. Ask me anything — I’ll always show you before I pay.' : 'I save your G$, find you rewards, and your G$ pays for Jara AI: research, assignments, exam practice and more. Ask me anything.'}`}
          />
        )}
        {messages.map((m) => (
          <ChatBubble key={m.id} me={m.role === 'user'} text={m.content} />
        ))}
        {optimistic && <ChatBubble me text={optimistic} />}
        {sending && (
          <div className="flex w-fit gap-1 rounded-2xl rounded-bl-md bg-white px-4 py-3 ring-1 ring-ink/10">
            {[0, 1, 2].map((i) => (
              <span key={i} className="h-2 w-2 animate-bounce rounded-full bg-forest/50" style={{ animationDelay: `${i * 0.12}s` }} />
            ))}
          </div>
        )}
        {confirm && !sending && (
          <div className="animate-pop ml-0 max-w-[88%] overflow-hidden rounded-2xl border border-ink/10 bg-white shadow-sm">
            <div className="bg-crest px-4 py-2 text-xs font-bold tracking-widest uppercase">Ready to pay</div>
            <div className="px-4 py-3">
              <p className="font-bold leading-snug">{confirm.summary}</p>
              {confirm.gd > 0 && <p className="mt-0.5 text-sm font-semibold text-ink/55">G$ {gdFmt(confirm.gd)} from your jars</p>}
            </div>
            <div className="grid grid-cols-2 border-t border-ink/10">
              <button onClick={() => send({ confirm: false })} className="py-3 text-sm font-semibold text-ink/60 hover:bg-[#f4f5ef]">
                Cancel
              </button>
              <button onClick={() => send({ confirm: true })} className="border-l border-ink/10 bg-forest py-3 text-sm font-semibold text-cream hover:bg-forest-soft">
                Pay it
              </button>
            </div>
          </div>
        )}
      </div>

      <div className="border-t-2 border-ink/10 bg-white px-3 pt-3">
        <div className="flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none]">
          {CHIPS.filter((c) => state.config.billsLive || !c.includes('₦')).map((c) => (
            <button
              key={c}
              onClick={() => send({ text: c })}
              disabled={sending}
              className="shrink-0 rounded-full bg-cream px-3.5 py-1.5 text-sm font-bold whitespace-nowrap ring-1 ring-ink/15 hover:ring-forest/40"
            >
              {c}
            </button>
          ))}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault()
            if (!text.trim()) return
            const t = text
            setText('')
            send({ text: t })
          }}
          className="flex items-center gap-2 py-3"
        >
          <input
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={state.config.billsLive ? 'Abeg send ₦500 airtime to 0803…' : 'Ask Jara anything…'}
            aria-label="Message Jara" className="min-w-0 flex-1 rounded-full bg-cream px-5 py-3.5 font-semibold ring-2 ring-transparent outline-none focus:ring-ink"
          />
          <button
            disabled={sending || !text.trim()}
            aria-label="Send"
            className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-mandarin text-xl font-bold text-ink transition hover:bg-mandarin-deep disabled:bg-ink/10 disabled:text-ink/30"
          >
            ↑
          </button>
        </form>
      </div>
    </section>
  )
}

function ChatBubble({ me, text }: { me: boolean; text: string }) {
  return (
    <div className={`flex ${me ? 'justify-end' : ''}`}>
      <p
        className={`max-w-[85%] rounded-2xl px-4 py-2.5 leading-snug font-medium whitespace-pre-line ${
          me ? 'rounded-br-md bg-forest text-cream' : 'rounded-bl-md bg-white text-ink ring-1 ring-ink/10'
        }`}
      >
        {me
          ? text
          : text.split(/(\*\*[^*]+\*\*|https:\/\/[^\s)]+)/g).map((part, i) =>
              part.startsWith('**') && part.endsWith('**') && part.length > 4 ? (
                <strong key={i} className="font-bold">{part.slice(2, -2)}</strong>
              ) : part.startsWith('https://') ? (
                <a key={i} href={part} target="_blank" rel="noreferrer" className="font-semibold break-all text-forest underline">
                  {part}
                </a>
              ) : (
                part
              ),
            )}
      </p>
    </div>
  )
}


function BudgetTransfer({ state, setState, flash }: { state: State; setState: (s: State) => void; flash: (s: string) => void }) {
  const [from, setFrom] = useState(state.snapshot.freeGd > 0 ? 'free' : 'light')
  const [to, setTo] = useState('ai')
  const [amount, setAmount] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  return <details className="budget-transfer border-t border-ink/8 px-5 py-4 sm:px-6">
    <summary className="cursor-pointer text-sm font-bold text-forest">Move money between jar budgets <span className="ml-1 text-xs font-normal text-ink/45">· No fee</span></summary>
    <p className="mt-3 text-sm leading-relaxed text-ink/60">Jars divide your available G$ into budgets. Purchases use only their own jar. Moving a budget here does not transfer tokens or charge a fee.</p>
    <form className="mt-3 grid gap-3 sm:grid-cols-2" onSubmit={async (event) => {
      event.preventDefault()
      setBusy(true)
      setError(null)
      try {
        setState(await api<State>('/api/jars', { action: 'move', from, kind: to, amountGd: amount }))
        setAmount('')
        flash('Jar budgets updated')
      } catch (err) { setError(err instanceof Error ? err.message : 'Could not move this budget') }
      finally { setBusy(false) }
    }}>
      <label className="grid gap-1 text-sm font-bold">From
        <select aria-label="From jar" value={from} onChange={(e) => setFrom(e.target.value)} className="min-w-0 rounded-xl border border-ink/20 bg-white p-3">
          <option value="free">Unassigned · G$ {gdFmt(state.snapshot.freeGd)}</option>
          {state.snapshot.jars.map((j) => <option key={j.kind} value={j.kind}>{j.label} · G$ {gdFmt(j.balanceGd)}</option>)}
        </select>
      </label>
      <label className="grid gap-1 text-sm font-bold">To
        <select aria-label="To jar" value={to} onChange={(e) => setTo(e.target.value)} className="min-w-0 rounded-xl border border-ink/20 bg-white p-3">
          {state.snapshot.jars.map((j) => <option key={j.kind} value={j.kind}>{j.label}</option>)}
        </select>
      </label>
      <label className="grid gap-1 text-sm font-bold">Amount in G$
        <input required inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className="min-w-0 rounded-xl border border-ink/20 bg-white p-3" placeholder="100" />
      </label>
      <button disabled={busy || from === to || !amount} className="app-button self-end justify-center bg-forest text-cream disabled:opacity-50">{busy ? 'Moving…' : 'Confirm budget move'}</button>
      {error && <p role="alert" className="text-sm font-bold sm:col-span-2">{error}</p>}
    </form>
  </details>
}
