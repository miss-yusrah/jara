'use client'

import Link from 'next/link'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createWalletClient, custom, type EIP1193Provider } from 'viem'
import { celo } from 'viem/chains'
import { DISCOS, DISCO_INFO, formatNgn } from '@/lib/catalog'
import { Icon, type IconName } from './Icon'
import { Jar, type JarColor, type JarIcon } from './Jar'

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
    lastRunAt: number | null
    inviteLink: string
  }
  aiRuns: { id: number; tool: string; input: string; output: string; costGd: number; demo: boolean; createdAt: number }[]
  aiTools: { id: string; name: string; blurb: string; priceGd: number; placeholder: string }[]
  rewards: { earnedGd: number; items: { title: string; detail: string; amountGd: number; done: boolean; progress: number }[] }
  snapshot: { jars: JarView[]; totalGd: number; freeGd: number; freeNgn: number; ngnPerGd: number }
  activity: Activity[]
  messages: Msg[]
  config: { chainMode: 'celo' | 'mock'; provider: string; billsLive: boolean; llm: string }
}

const JAR_COLOR: Record<JarView['kind'], JarColor> = { light: 'crest', data: 'mandarin', airtime: 'forest', ai: 'mandarin' }
const JAR_ICON: Record<JarView['kind'], JarIcon> = { light: 'bolt', data: 'signal', airtime: 'phone', ai: 'spark' }
const JAR_LID: Record<JarView['kind'], string> = { light: '#ffc72c', data: '#ffc72c', airtime: '#ff6b00', ai: '#1d5a3f' }
const IDENTITY = '0xC361A6E67822a0EDc17D899227dd9FC50BD62F42'
const CONNECT_ABI = [
  { type: 'function', name: 'connectAccount', stateMutability: 'nonpayable', inputs: [{ name: 'account', type: 'address' }], outputs: [] },
] as const

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })
  const json = await res.json()
  if (!res.ok) throw new Error(json.error ?? 'Something went wrong')
  return json as T
}

function injected(): EIP1193Provider | null {
  return typeof window !== 'undefined' ? ((window as unknown as { ethereum?: EIP1193Provider }).ethereum ?? null) : null
}

const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`
const gdFmt = (n: number) => n.toLocaleString('en-US', { maximumFractionDigits: 0 })

// ---------- root ----------

export function AppClient({ tgCode, refCode }: { tgCode?: string; refCode?: string }) {
  const [state, setState] = useState<State | null | undefined>(undefined)
  const [toast, setToast] = useState<string | null>(null)

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

  return (
    <div className="min-h-dvh bg-cream">
      <TopBar state={state ?? null} />
      {state === undefined && <Loading />}
      {state === null && <Welcome onStart={setState} refCode={refCode} />}
      {state && !state.user.connected && <Onboarding state={state} setState={setState} flash={flash} />}
      {state && state.user.connected && <Dashboard state={state} setState={setState} flash={flash} />}
      {toast && (
        <div className="fixed inset-x-0 bottom-6 z-50 flex justify-center px-4">
          <p className="animate-pop max-w-md rounded-full bg-ink px-5 py-3 text-center font-bold text-cream shadow-[0_10px_30px_rgba(11,31,22,0.35)]">{toast}</p>
        </div>
      )}
    </div>
  )
}

function TopBar({ state }: { state: State | null }) {
  return (
    <header className="border-b-[3px] border-ink bg-forest">
      <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-3 sm:px-6">
        <Link href="/" className="flex items-center gap-2 text-cream">
          <span className="grid h-9 w-9 place-items-center rounded-xl border-[3px] border-ink bg-crest text-ink shadow-chunk-sm"><Icon name="jar" className="h-5 w-5" /></span>
          <span className="text-xl font-extrabold">Jara</span>
        </Link>
        <div className="flex items-center gap-3">
          {state?.user.connected && (
            <Link href="/app/ai" className="press flex items-center gap-1.5 rounded-full border-[2.5px] border-ink bg-crest px-3.5 py-1.5 text-sm font-extrabold text-ink">
              <Icon name="sparkle" className="h-4 w-4" /> Jara AI
            </Link>
          )}
          {state?.config.chainMode === 'mock' && <span className="text-xs font-bold tracking-widest text-cream/50 uppercase">Demo</span>}
          {state?.user.name && (
            <span className="grid h-9 w-9 place-items-center rounded-full bg-crest text-sm font-extrabold text-ink">{state.user.name.slice(0, 1).toUpperCase()}</span>
          )}
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

function Welcome({ onStart, refCode }: { onStart: (s: State) => void; refCode?: string }) {
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  return (
    <main className="mx-auto grid max-w-md gap-8 px-4 py-12">
      <div className="flex justify-center">
        <Jar pct={62} color="mandarin" className="h-44 animate-bob" />
      </div>
      <div className="text-center">
        <h1 className="text-5xl leading-none font-extrabold tracking-tight">Hi, I&apos;m Jara.</h1>
        <p className="mt-4 text-lg font-medium text-ink/75">I&apos;m your AI agent. I collect your GoodDollar every day and put it to work: Jara AI for research and assignments, savings jars, and G$ rewards.</p>
      </div>
      <form
        className="grid gap-4"
        onSubmit={async (e) => {
          e.preventDefault()
          setBusy(true)
          try {
            onStart(await api<State>('/api/session', { name, ref: refCode }))
          } finally {
            setBusy(false)
          }
        }}
      >
        <label className="grid gap-2">
          <span className="font-extrabold">What should I call you?</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="e.g. Amaka"
            className="rounded-2xl border-[3px] border-ink bg-white px-4 py-3.5 text-lg font-semibold shadow-chunk-sm outline-none focus:bg-crest-soft"
          />
        </label>
        <button disabled={busy} className="press rounded-2xl border-[3px] border-ink bg-mandarin px-6 py-4 text-lg font-extrabold shadow-chunk disabled:opacity-60">
          {busy ? 'Setting up…' : "Let's go →"}
        </button>
      </form>
    </main>
  )
}

// ---------- onboarding ----------

function Onboarding({ state, setState, flash }: { state: State; setState: (s: State) => void; flash: (t: string) => void }) {
  const mock = state.config.chainMode === 'mock'
  const [address, setAddress] = useState(state.user.rootAddress ?? '')
  const [busy, setBusy] = useState<string | null>(null)
  const step = state.user.rootAddress ? 2 : 1

  const act = async (label: string, fn: () => Promise<void>) => {
    setBusy(label)
    try {
      await fn()
    } catch (err) {
      flash(err instanceof Error ? err.message.split('\n')[0].slice(0, 140) : 'Something went wrong')
    } finally {
      setBusy(null)
    }
  }

  const useWallet = () =>
    act('wallet', async () => {
      const eth = injected()
      if (!eth) throw new Error('No wallet found in this browser. Paste your address instead.')
      const [addr] = (await eth.request({ method: 'eth_requestAccounts' })) as string[]
      setAddress(addr)
      setState(await api<State>('/api/onboard', { action: 'root', address: addr }))
    })

  const approve = () =>
    act('approve', async () => {
      if (mock) {
        setState(await api<State>('/api/onboard', { action: 'check' }))
        return
      }
      const eth = injected()
      if (!eth) throw new Error("Open this page in your wallet's browser, or use GoodDollar's connect tool below.")
      const wallet = createWalletClient({ chain: celo, transport: custom(eth) })
      const [account] = await wallet.requestAddresses()
      if (account.toLowerCase() !== state.user.rootAddress?.toLowerCase()) {
        throw new Error(`Switch your wallet to ${short(state.user.rootAddress ?? '')} — your verified GoodDollar account.`)
      }
      await wallet.switchChain({ id: celo.id }).catch(() => wallet.addChain({ chain: celo }))
      const hash = await wallet.writeContract({
        account,
        address: IDENTITY,
        abi: CONNECT_ABI,
        functionName: 'connectAccount',
        args: [state.user.agentAddress as `0x${string}`],
      })
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

  return (
    <main className="mx-auto grid max-w-xl gap-6 px-4 py-10">
      <div>
        <p className="text-sm font-extrabold tracking-widest text-mandarin uppercase">Setup · 1 minute</p>
        <h1 className="mt-2 text-4xl leading-none font-extrabold tracking-tight sm:text-5xl">
          {state.user.name ? `${state.user.name}, let's` : "Let's"} connect your GoodDollar.
        </h1>
      </div>

      <Step n={1} title="Your GoodDollar account" done={step > 1} active={step === 1}>
        {step === 1 ? (
          <div className="grid gap-3">
            <p className="font-medium text-ink/75">The wallet you verified your face with in GoodWallet / GoodDapp.</p>
            <button onClick={useWallet} disabled={!!busy} className="press rounded-2xl border-[3px] border-ink bg-crest px-5 py-3 font-extrabold shadow-chunk-sm">
              {busy === 'wallet' ? 'Connecting…' : 'Use my wallet'}
            </button>
            <div className="flex items-center gap-3 text-sm font-bold text-ink/50">
              <span className="h-[3px] flex-1 bg-ink/15" />
              or paste it
              <span className="h-[3px] flex-1 bg-ink/15" />
            </div>
            <div className="flex gap-2">
              <input
                value={address}
                onChange={(e) => setAddress(e.target.value.trim())}
                placeholder="0x…"
                className="min-w-0 flex-1 rounded-2xl border-[3px] border-ink bg-white px-4 py-3 font-mono text-sm shadow-chunk-sm outline-none"
              />
              <button
                onClick={() => act('root', async () => setState(await api<State>('/api/onboard', { action: 'root', address })))}
                disabled={!!busy || !address}
                className="press rounded-2xl border-[3px] border-ink bg-mandarin px-5 font-extrabold shadow-chunk-sm disabled:opacity-50"
              >
                {busy === 'root' ? '…' : 'Next'}
              </button>
            </div>
            {mock && (
              <button
                onClick={() => act('root', async () => setState(await api<State>('/api/onboard', { action: 'root', address: '0x1111111111111111111111111111111111111111' })))}
                className="text-left text-sm font-bold text-forest underline"
              >
                Demo: use a test address
              </button>
            )}
            <a href="https://wallet.gooddollar.org" target="_blank" rel="noreferrer" className="text-sm font-bold text-forest underline">
              Not verified yet? Get your G$ in GoodWallet first →
            </a>
          </div>
        ) : (
          <p className="font-mono text-sm font-bold">{short(state.user.rootAddress ?? '')} <Icon name="check" className="inline h-4 w-4 text-forest" strokeWidth={3} /></p>
        )}
      </Step>

      <Step n={2} title="Let Jara claim for you" done={false} active={step === 2}>
        {step === 2 && (
          <div className="grid gap-3">
            <p className="font-medium text-ink/75">
              Approve one small transaction that links your Jara jar to your GoodDollar account. Jara can then collect your daily G$ — it can&apos;t touch your main wallet.
            </p>
            <div className="rounded-2xl border-[3px] border-dashed border-ink/40 bg-white px-4 py-3">
              <p className="text-xs font-extrabold tracking-wider text-ink/50 uppercase">Your jar address</p>
              <p className="font-mono text-sm font-bold break-all">{state.user.agentAddress}</p>
            </div>
            <button onClick={approve} disabled={!!busy} className="press rounded-2xl border-[3px] border-ink bg-mandarin px-5 py-4 text-lg font-extrabold shadow-chunk disabled:opacity-60">
              {busy === 'approve' ? 'Waiting for approval…' : mock ? 'Approve (demo)' : 'Approve in my wallet'}
            </button>
            {!mock && (
              <>
                <button
                  onClick={() => act('check', async () => setState(await api<State>('/api/onboard', { action: 'check' })))}
                  disabled={!!busy}
                  className="press rounded-2xl border-[3px] border-ink bg-cream px-5 py-3 font-extrabold shadow-chunk-sm"
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
    </main>
  )
}

function Step({ n, title, done, active, children }: { n: number; title: string; done: boolean; active: boolean; children: React.ReactNode }) {
  return (
    <section
      className={`rounded-3xl border-[3px] border-ink p-5 transition ${active ? 'bg-white shadow-chunk-lg' : 'bg-cream opacity-70'} ${done ? 'bg-crest-soft opacity-100' : ''}`}
    >
      <div className="mb-3 flex items-center gap-3">
        <span className={`grid h-9 w-9 place-items-center rounded-full border-[3px] border-ink font-extrabold ${done ? 'bg-forest text-cream' : 'bg-crest'}`}>
          {done ? <Icon name="check" className="h-4 w-4" strokeWidth={3} /> : n}
        </span>
        <h2 className="text-xl font-extrabold">{title}</h2>
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
const LANE_OF: Record<string, Lane | null> = { claim: 'save', deposit: 'save', move: 'save', pay: 'pay', refund: 'pay', reward: 'rewards', ai: 'ai', agent: null }
const LANES: { id: Lane; label: string; verb: string; color: string; ink: string }[] = [
  { id: 'save', label: 'Saving', verb: 'Claims your G$ daily', color: 'bg-crest', ink: 'text-ink' },
  { id: 'pay', label: 'Paying', verb: 'Pays bills when due', color: 'bg-mandarin', ink: 'text-ink' },
  { id: 'rewards', label: 'Rewards', verb: 'Hunts G$ bonuses', color: 'bg-cream', ink: 'text-ink' },
  { id: 'ai', label: 'AI', verb: 'Your G$ pays for AI help', color: 'bg-forest-soft', ink: 'text-cream' },
]

function ago(ts: number | null) {
  if (!ts) return 'not yet'
  const m = Math.round((Date.now() - ts) / 60_000)
  if (m < 1) return 'just now'
  if (m < 60) return `${m} min ago`
  const h = Math.round(m / 60)
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`
}

function Dashboard({ state, setState, flash }: { state: State; setState: (s: State) => void; flash: (t: string) => void }) {
  const [tab, setTab] = useState<'home' | 'work' | 'chat'>('home')
  const [editing, setEditing] = useState<JarView | null>(null)
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

  const show = (t: 'home' | 'work' | 'chat') => `${tab === t ? '' : 'hidden'} lg:contents`

  return (
    <main className="mx-auto max-w-6xl px-4 pt-5 pb-28 sm:px-6 lg:pt-8 lg:pb-12">
      <div className="mb-4 grid grid-cols-3 rounded-full bg-forest/10 p-1 lg:hidden">
        {(['home', 'work', 'chat'] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`rounded-full py-2.5 text-sm font-extrabold transition ${tab === t ? 'bg-forest text-cream shadow' : 'text-forest'}`}>
            {t === 'home' ? 'Agent' : t === 'work' ? 'Rewards' : 'Chat'}
          </button>
        ))}
      </div>

      <AiLaunch state={state} />

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1.25fr)_minmax(0,1fr)] lg:items-start">
        <div className="grid gap-6">
          <div className={show('home')}>
            <AgentPanel state={state} busy={busy === 'agent'} onRun={runAgent} lastSteps={lastSteps} />
            <JarShelf jars={snap.jars} onEdit={setEditing} totalGd={snap.totalGd} rate={snap.ngnPerGd} />
          </div>
          <div className={show('work')}>
            <RewardsCard state={state} flash={flash} />
          </div>
          <div className={show('home')}>
            <section>
              <div className="mb-3 flex items-center justify-between">
                <h2 className="text-xl font-extrabold">Agent log</h2>
                <TelegramChip state={state} />
              </div>
              <AgentLog items={state.activity} chainMode={state.config.chainMode} />
            </section>
          </div>
        </div>
        <div className={tab === 'chat' ? '' : 'hidden lg:block'}>
          <Chat state={state} setState={setState} flash={flash} />
        </div>
      </div>

      {mock && <DemoControls run={run} setState={setState} rate={snap.ngnPerGd} onRunAgent={runAgent} />}

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
  )
}

function AgentPanel({ state, busy, onRun, lastSteps }: { state: State; busy: boolean; onRun: () => void; lastSteps: { lane: Lane; text: string }[] | null }) {
  const { user, snapshot: snap } = state
  const [now] = useState(() => Date.now())
  const week = now - 7 * 86_400_000
  const recent = state.activity.filter((a) => a.createdAt > week && a.status !== 'failed')
  const earnedGd = recent
    .filter((a) => ['claim', 'reward', 'deposit'].includes(a.type) && a.amountWei)
    .reduce((s, a) => s + Number(BigInt(a.amountWei!) / 10n ** 18n), 0)
  const spentGd = recent.filter((a) => (a.type === 'pay' || a.type === 'ai') && a.amountWei).reduce((s, a) => s + Number(BigInt(a.amountWei!) / 10n ** 18n), 0)

  return (
    <section className="overflow-hidden rounded-[2rem] border-[4px] border-ink bg-forest text-cream shadow-chunk-lg">
      <div className="flex flex-wrap items-start justify-between gap-4 p-6 sm:p-8">
        <div>
          <p className="font-semibold text-cream/60">
            {greeting()}
            {user.name ? `, ${user.name}` : ''}
          </p>
          <div className="mt-2 flex items-center gap-3">
            <span className="relative flex h-3.5 w-3.5">
              <span className={`absolute inline-flex h-full w-full rounded-full bg-mandarin opacity-75 ${busy ? 'animate-ping' : ''}`} />
              <span className="relative inline-flex h-3.5 w-3.5 rounded-full bg-mandarin" />
            </span>
            <p className="text-3xl leading-none font-extrabold tracking-tight sm:text-4xl">{busy ? 'Jara is working…' : 'Jara is on it'}</p>
          </div>
          <p className="mt-2 text-sm font-semibold text-cream/55">Last check-in {ago(user.lastRunAt)} · checks in by itself every few hours</p>
        </div>
        <button
          onClick={onRun}
          disabled={busy}
          className="press rounded-2xl border-[3px] border-ink bg-mandarin px-5 py-3 font-extrabold text-ink shadow-chunk-sm disabled:opacity-70"
        >
          {busy ? 'Working…' : 'Check in now'}
        </button>
      </div>

      <div className={`grid grid-cols-2 gap-px border-t-[4px] border-ink bg-ink ${state.config.billsLive ? 'sm:grid-cols-4' : 'sm:grid-cols-3'}`}>
        {LANES.filter((l) => state.config.billsLive || l.id !== 'pay').map((l) => {
          const items = recent.filter((a) => LANE_OF[a.type] === l.id)
          const latest = items[0]
          const fresh = lastSteps?.filter((s) => s.lane === l.id) ?? []
          return (
            <div key={l.id} className={`${l.color} ${l.ink} relative p-4`}>
              <div className="flex items-center justify-between">
                <p className="text-xs font-extrabold tracking-widest uppercase opacity-70">{l.label}</p>
                <span className="text-2xl leading-none font-extrabold tabular-nums">{items.length}</span>
              </div>
              <p className="mt-2 line-clamp-2 min-h-[2.5rem] text-sm leading-snug font-bold">{fresh[0]?.text ?? latest?.title ?? l.verb}</p>
              {fresh.length > 0 && <span className="absolute top-2 right-2 h-2.5 w-2.5 animate-pulse rounded-full bg-ink" />}
            </div>
          )
        })}
      </div>

      {lastSteps && lastSteps.length > 0 && (
        <div className="animate-pop border-t-[4px] border-ink bg-cream px-6 py-4 text-ink sm:px-8">
          <p className="text-xs font-extrabold tracking-widest text-ink/50 uppercase">Just now, Jara…</p>
          <ul className="mt-2 grid gap-1.5">
            {lastSteps.map((st, i) => (
              <li key={i} className="flex items-start gap-2.5 text-sm font-bold">
                <span className={`mt-1 h-2.5 w-2.5 shrink-0 rounded-full ${st.lane === 'save' ? 'bg-crest' : st.lane === 'pay' ? 'bg-mandarin' : st.lane === 'ai' ? 'bg-forest' : 'bg-ink'}`} />
                <span>{st.text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}

      <div className="flex flex-wrap items-center justify-between gap-2 border-t-[4px] border-ink bg-forest-deep px-6 py-3 text-sm font-bold sm:px-8">
        <span className="text-crest">+G$ {gdFmt(earnedGd)} in this week</span>
        <span className="text-cream/70">−G$ {gdFmt(spentGd)} on bills & AI</span>
        <span className="flex items-center gap-1.5 text-cream/70"><Icon name="flame" className="h-4 w-4 text-mandarin" /> {user.streak}-day streak</span>
        <span className="text-cream">{formatNgn(Math.floor(snap.totalGd * snap.ngnPerGd))} saved</span>
      </div>
    </section>
  )
}

function JarShelf({ jars, onEdit, totalGd, rate }: { jars: JarView[]; onEdit: (j: JarView) => void; totalGd: number; rate: number }) {
  return (
    <section className="rounded-[2rem] border-[4px] border-ink bg-white p-5 shadow-chunk sm:p-6">
      <div className="flex items-baseline justify-between">
        <h2 className="text-xl font-extrabold">Bill jars</h2>
        <p className="text-sm font-bold text-ink/50">
          G$ {gdFmt(totalGd)} · {formatNgn(Math.floor(totalGd * rate))}
        </p>
      </div>
      <div className="mt-4 grid grid-cols-4 gap-2 sm:gap-4">
        {jars.map((j) => (
          <button key={j.kind} onClick={() => onEdit(j)} className="group text-left">
            <div className="flex justify-center">
              <Jar
                pct={j.pct}
                color={JAR_COLOR[j.kind]}
                lid={JAR_LID[j.kind]}
                className="h-24 transition group-hover:-translate-y-1 sm:h-32"
                label={{ icon: JAR_ICON[j.kind], text: j.label }}
              />
            </div>
            <p className="mt-2 text-sm font-extrabold">
              {j.kind === 'ai' ? `G$ ${gdFmt(j.balanceGd)}` : formatNgn(j.balanceNgn)}{' '}
              <span className="hidden font-bold text-ink/45 sm:inline">/ {formatNgn(j.targetNgn)}</span>
            </p>
            <p className="text-xs font-bold text-ink/50">
              {j.kind === 'ai' ? 'Pays for AI help' : j.dueAt ? `Due ${new Date(j.dueAt).toLocaleDateString('en-NG', { weekday: 'short', day: 'numeric' })}` : j.everyDays ? `Every ${j.everyDays} days` : j.autoPay ? 'Auto-pays when full' : 'Tap to set up'}
            </p>
          </button>
        ))}
      </div>
    </section>
  )
}

function AiLaunch({ state }: { state: State }) {
  const quick = [
    { id: 'research', label: 'Research a topic' },
    { id: 'assignment', label: 'Help with an assignment' },
    { id: 'exam', label: 'Exam practice' },
    { id: 'brainstorm', label: 'Brainstorm ideas' },
  ]
  return (
    <section className="mb-6 overflow-hidden rounded-[2rem] border-[4px] border-ink bg-mandarin shadow-chunk">
      <div className="grid gap-5 p-5 sm:p-7 lg:grid-cols-[1fr_auto] lg:items-center">
        <div>
          <p className="inline-flex items-center gap-1.5 rounded-full bg-ink px-3 py-1 text-xs font-extrabold tracking-widest text-crest uppercase">
            <Icon name="sparkle" className="h-3.5 w-3.5" /> Jara AI
          </p>
          <h2 className="mt-3 text-3xl leading-[0.95] font-extrabold tracking-tight sm:text-4xl">Research, assignments and more. Paid with your G$.</h2>
          <p className="mt-2 max-w-xl font-semibold text-ink/75">Chat like you would with ChatGPT. Every answer downloads as a neat PDF.</p>
          <div className="mt-4 flex flex-wrap gap-2">
            {quick.map((q) => (
              <Link key={q.id} href={`/app/ai?tool=${q.id}`} className="rounded-full border-2 border-ink bg-cream px-3.5 py-1.5 text-sm font-bold hover:bg-white">
                {q.label}
              </Link>
            ))}
          </div>
        </div>
        <div className="flex flex-col items-start gap-2 lg:items-end">
          <Link href="/app/ai" className="press inline-flex items-center gap-2 rounded-2xl border-[3px] border-ink bg-forest px-6 py-4 text-lg font-extrabold text-cream shadow-chunk-sm">
            Open Jara AI <Icon name="arrow" className="h-5 w-5" strokeWidth={2.75} />
          </Link>
          <p className="text-sm font-bold text-ink/70">You have G$ {gdFmt(state.snapshot.totalGd)}</p>
        </div>
      </div>
    </section>
  )
}

function RewardsCard({ state, flash }: { state: State; flash: (t: string) => void }) {
  const { rewards, user } = state
  return (
    <section className="rounded-[2rem] border-[4px] border-ink bg-white p-5 shadow-chunk sm:p-6">
      <div className="flex items-baseline justify-between">
        <h2 className="text-xl font-extrabold">Rewards</h2>
        <p className="font-extrabold text-forest">G$ {gdFmt(rewards.earnedGd)} earned</p>
      </div>
      <p className="mt-1 text-sm font-semibold text-ink/55">Jara collects these for you automatically.</p>
      <ul className="mt-4 grid gap-2.5">
        {rewards.items.map((r) => (
          <li key={r.title} className="flex items-center gap-3">
            <span className={`grid h-8 w-8 shrink-0 place-items-center rounded-full text-sm font-extrabold ${r.done ? 'bg-forest text-cream' : 'bg-cream ring-2 ring-ink/10'}`}>
              <Icon name={r.done ? 'check' : 'star'} className="h-4 w-4" strokeWidth={r.done ? 3 : 2.25} />
            </span>
            <div className="min-w-0 flex-1">
              <div className="flex items-baseline justify-between gap-2">
                <p className={`truncate font-bold ${r.done ? 'text-ink/45 line-through' : ''}`}>{r.title}</p>
                <span className="shrink-0 text-sm font-extrabold">+G$ {gdFmt(r.amountGd)}</span>
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
        className="mt-4 w-full rounded-2xl bg-cream py-3 text-sm font-extrabold ring-2 ring-ink/10 hover:ring-ink/30"
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

function JarSheet({ jar, onClose, onSave }: { jar: JarView; onClose: () => void; onSave: (p: Record<string, unknown>) => Promise<void> }) {
  const [target, setTarget] = useState(jar.targetNgn)
  const [autoPay, setAutoPay] = useState(jar.autoPay)
  const [phone, setPhone] = useState(jar.details.phone ?? '')
  const [disco, setDisco] = useState(jar.details.disco ?? 'kaduna')
  const [meterType, setMeterType] = useState(jar.details.meterType ?? 'prepaid')
  const [meter, setMeter] = useState(jar.details.meterNumber ?? '')
  const [every, setEvery] = useState<number | null>(jar.everyDays)
  const [saving, setSaving] = useState(false)
  const presets = jar.kind === 'light' ? [2000, 3000, 5000, 10000] : jar.kind === 'data' ? [500, 1000, 1500, 3000] : [200, 500, 1000, 2000]
  const field = 'w-full rounded-xl border-2 border-ink/15 bg-white px-4 py-3 font-semibold outline-none focus:border-ink'

  return (
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/50 backdrop-blur-[2px] sm:items-center sm:p-4" onClick={onClose}>
      <div onClick={(e) => e.stopPropagation()} className="animate-pop max-h-[92dvh] w-full max-w-md overflow-y-auto rounded-t-[2rem] bg-cream sm:rounded-[2rem] sm:border-[4px] sm:border-ink sm:shadow-chunk-lg">
        <div className="flex items-center gap-4 bg-forest px-6 py-5 text-cream">
          <Jar pct={jar.pct} color={JAR_COLOR[jar.kind]} lid={JAR_LID[jar.kind]} className="h-16 w-12" />
          <div className="flex-1">
            <h3 className="text-2xl font-extrabold">{jar.label} jar</h3>
            <p className="text-sm font-semibold text-cream/60">
              {formatNgn(jar.balanceNgn)} saved · {jar.pct}%
            </p>
          </div>
          <button onClick={onClose} className="grid h-9 w-9 place-items-center rounded-full bg-cream/10 font-bold hover:bg-cream/20" aria-label="Close">
            <Icon name="x" className="h-4 w-4" strokeWidth={3} />
          </button>
        </div>

        <div className="grid gap-5 p-6">
          <div>
            <p className="mb-2 text-sm font-extrabold tracking-wide text-ink/60 uppercase">Save up to</p>
            <div className="grid grid-cols-4 gap-2">
              {presets.map((p) => (
                <button
                  key={p}
                  onClick={() => setTarget(p)}
                  className={`rounded-xl py-2.5 font-extrabold transition ${target === p ? 'bg-ink text-cream' : 'bg-white text-ink ring-2 ring-ink/10 hover:ring-ink/30'}`}
                >
                  {p >= 1000 ? `₦${p / 1000}k` : `₦${p}`}
                </button>
              ))}
            </div>
          </div>

          {jar.kind === 'ai' ? (
            <p className="rounded-2xl bg-white px-4 py-3 text-sm font-semibold text-ink/65 ring-2 ring-ink/10">
              This jar pays for your AI helpers — research, assignment help, brainstorming, exam practice and more. Jara fills it from your daily G$.
            </p>
          ) : jar.kind === 'light' ? (
            <div className="grid gap-3">
              <p className="text-sm font-extrabold tracking-wide text-ink/60 uppercase">Your meter</p>
              <select value={disco} onChange={(e) => setDisco(e.target.value)} className={field}>
                {DISCOS.map((d) => (
                  <option key={d} value={d}>
                    {DISCO_INFO[d].short} — {DISCO_INFO[d].region}
                  </option>
                ))}
              </select>
              <div className="grid grid-cols-2 gap-1 rounded-xl bg-white p-1 ring-2 ring-ink/10">
                {['prepaid', 'postpaid'].map((t) => (
                  <button key={t} onClick={() => setMeterType(t)} className={`rounded-lg py-2 font-bold capitalize ${meterType === t ? 'bg-crest' : ''}`}>
                    {t}
                  </button>
                ))}
              </div>
              <input value={meter} onChange={(e) => setMeter(e.target.value)} inputMode="numeric" placeholder="Meter number" className={field} />
              {jar.details.customerName && <p className="flex items-center gap-1 text-sm font-bold text-forest"><Icon name="check" className="h-4 w-4" strokeWidth={3} /> {jar.details.customerName}</p>}
            </div>
          ) : (
            <div className="grid gap-2">
              <p className="text-sm font-extrabold tracking-wide text-ink/60 uppercase">Phone number</p>
              <input value={phone} onChange={(e) => setPhone(e.target.value)} inputMode="tel" placeholder="0803 123 4567" className={field} />
            </div>
          )}

          {jar.kind !== 'ai' && (
          <>
          <div>
            <p className="mb-2 text-sm font-extrabold tracking-wide text-ink/60 uppercase">This bill comes round</p>
            <div className="grid grid-cols-4 gap-2">
              {[null, 7, 14, 30].map((d) => (
                <button
                  key={String(d)}
                  onClick={() => setEvery(d)}
                  className={`rounded-xl py-2.5 text-sm font-extrabold transition ${every === d ? 'bg-ink text-cream' : 'bg-white ring-2 ring-ink/10 hover:ring-ink/30'}`}
                >
                  {d ? `${d} days` : 'When full'}
                </button>
              ))}
            </div>
            <p className="mt-1.5 text-xs font-semibold text-ink/50">Jara tops this jar up before it’s due and pays on time.</p>
          </div>

          <button onClick={() => setAutoPay(!autoPay)} className="flex w-full items-center justify-between rounded-2xl bg-white px-4 py-3 text-left ring-2 ring-ink/10">
            <span>
              <span className="block font-extrabold">Pay automatically</span>
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
            className="press w-full rounded-2xl border-[3px] border-ink bg-mandarin py-4 text-lg font-extrabold shadow-chunk disabled:opacity-60"
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
  reward: { icon: 'star', tint: 'bg-cream ring-2 ring-ink/15', sign: '+' },
  refund: { icon: 'undo', tint: 'bg-crest-soft', sign: '+' },
  pay: { icon: 'bolt', tint: 'bg-mandarin', sign: '−' },
  move: { icon: 'arrow', tint: 'bg-cream', sign: '' },
  ai: { icon: 'sparkle', tint: 'bg-forest-soft text-cream', sign: '−' },
  agent: { icon: 'jar', tint: 'bg-ink text-cream', sign: '' },
}

function AgentLog({ items, chainMode }: { items: Activity[]; chainMode: string }) {
  if (!items.length) return <p className="rounded-2xl bg-white p-6 text-center font-semibold text-ink/50 ring-2 ring-ink/10">Nothing yet. Tap “Check in now” to put Jara to work.</p>
  return (
    <ul className="overflow-hidden rounded-2xl bg-white ring-2 ring-ink/10">
      {items
        .filter((a) => a.type !== 'agent')
        .slice(0, 10)
        .map((a, i) => {
          const st = ACT_STYLE[a.type] ?? ACT_STYLE.move
          const gd = a.amountWei ? Number(BigInt(a.amountWei) / 10n ** 18n) : null
          return (
            <li key={a.id} className={`flex items-center gap-3 px-4 py-3 ${i ? 'border-t border-ink/10' : ''}`}>
              <span className={`grid h-10 w-10 shrink-0 place-items-center rounded-full text-base font-extrabold ${a.status === 'failed' ? 'bg-red-100' : st.tint}`}>
                <Icon name={a.status === 'failed' ? 'alert' : st.icon} className="h-5 w-5" />
              </span>
              <div className="min-w-0 flex-1">
                <p className="truncate font-bold">{a.title}</p>
                <p className="truncate text-sm font-medium text-ink/50">
                  {a.detail ?? ago(a.createdAt)}
                  {a.status === 'pending' && ' · processing'}
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
                <span className={`shrink-0 font-extrabold tabular-nums ${st.sign === '+' ? 'text-forest' : 'text-ink'}`}>
                  {st.sign}G$ {gd.toLocaleString()}
                </span>
              )}
            </li>
          )
        })}
    </ul>
  )
}

function TelegramChip({ state }: { state: State }) {
  const { telegramLinked, telegramLink } = state.user
  if (telegramLinked) return <span className="flex items-center gap-1 text-sm font-bold text-forest"><Icon name="check" className="h-4 w-4" strokeWidth={3} /> On Telegram</span>
  if (!telegramLink) return null
  return (
    <a href={telegramLink} target="_blank" rel="noreferrer" className="rounded-full bg-forest px-3 py-1.5 text-sm font-bold text-cream hover:bg-forest-soft">
      Get morning updates on Telegram →
    </a>
  )
}

// ---------- chat ----------

const CHIPS = ['Help me brainstorm a project', '₦200 airtime for me', 'My rewards', 'What’s in my jars?', 'Buy ₦3000 light']

function Chat({ state, setState, flash }: { state: State; setState: (s: State) => void; flash: (t: string) => void }) {
  const [text, setText] = useState('')
  const [sending, setSending] = useState(false)
  const [confirm, setConfirm] = useState<{ summary: string; gd: number } | null>(state.user.hasPending ? { summary: 'Your last request', gd: 0 } : null)
  const [optimistic, setOptimistic] = useState<string | null>(null)
  const scrollRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' })
  }, [state.messages.length, optimistic, sending, confirm])

  const send = async (body: { text?: string; confirm?: boolean }) => {
    setSending(true)
    if (body.text) setOptimistic(body.text)
    if (body.confirm !== undefined) setConfirm(null)
    try {
      const r = await api<{ reply: { text: string; confirm?: { summary: string; gd: number } }; state: State }>('/api/chat', body)
      setState(r.state)
      setConfirm(r.reply.confirm ?? null)
    } catch (err) {
      flash(err instanceof Error ? err.message : 'Could not send')
    } finally {
      setOptimistic(null)
      setSending(false)
    }
  }

  const status = state.config.llm === 'antseed' ? 'AI agent · on AntSeed' : state.config.llm === 'rules' ? 'AI agent · quick mode' : 'AI agent · online'

  return (
    <section className="flex h-[calc(100dvh-10.5rem)] flex-col overflow-hidden rounded-[2rem] border-[4px] border-ink bg-white shadow-chunk-lg lg:sticky lg:top-6 lg:h-[680px]">
      <div className="flex items-center gap-3 bg-forest px-5 py-4 text-cream">
        <div className="relative">
          <span className="grid h-11 w-11 place-items-center rounded-full bg-crest text-ink"><Icon name="jar" className="h-6 w-6" /></span>
          <span className="absolute right-0 bottom-0 h-3 w-3 rounded-full border-2 border-forest bg-mandarin" />
        </div>
        <div>
          <p className="text-lg leading-none font-extrabold">Jara</p>
          <p className="mt-1 text-xs font-semibold text-cream/60">{status}</p>
        </div>
      </div>

      <div ref={scrollRef} className="flex-1 space-y-2.5 overflow-y-auto bg-cream/60 px-4 py-5">
        {state.messages.length === 0 && !optimistic && (
          <ChatBubble
            me={false}
            text={`Hi${state.user.name ? ` ${state.user.name}` : ''}! I’m your AI agent. I save your G$, pay your bills, find you rewards — and your G$ pays for AI help with research, assignments and ideas. Ask me anything — I’ll always show you before I pay.`}
          />
        )}
        {state.messages.map((m) => (
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
          <div className="animate-pop ml-0 max-w-[88%] overflow-hidden rounded-2xl border-[3px] border-ink bg-white shadow-chunk-sm">
            <div className="bg-crest px-4 py-2 text-xs font-extrabold tracking-widest uppercase">Ready to pay</div>
            <div className="px-4 py-3">
              <p className="font-bold leading-snug">{confirm.summary}</p>
              {confirm.gd > 0 && <p className="mt-0.5 text-sm font-semibold text-ink/55">G$ {gdFmt(confirm.gd)} from your jars</p>}
            </div>
            <div className="grid grid-cols-2 border-t-[3px] border-ink">
              <button onClick={() => send({ confirm: false })} className="py-3 font-extrabold hover:bg-cream">
                Cancel
              </button>
              <button onClick={() => send({ confirm: true })} className="border-l-[3px] border-ink bg-mandarin py-3 font-extrabold hover:bg-mandarin-deep">
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
              className="shrink-0 rounded-full bg-cream px-3.5 py-1.5 text-sm font-bold whitespace-nowrap ring-1 ring-ink/15 hover:ring-ink/40"
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
            placeholder="Abeg send ₦500 airtime to 0803…"
            className="min-w-0 flex-1 rounded-full bg-cream px-5 py-3.5 font-semibold ring-2 ring-transparent outline-none focus:ring-ink"
          />
          <button
            disabled={sending || !text.trim()}
            aria-label="Send"
            className="grid h-12 w-12 shrink-0 place-items-center rounded-full bg-mandarin text-xl font-extrabold text-ink transition hover:bg-mandarin-deep disabled:bg-ink/10 disabled:text-ink/30"
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
        {text}
      </p>
    </div>
  )
}
