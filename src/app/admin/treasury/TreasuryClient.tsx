'use client'

import { useCallback, useEffect, useState } from 'react'
import { Icon } from '@/components/Icon'

interface Report {
  rates: { usdPerGd: number; ngnPerGd: number }
  ai: { uses: number; users: number; gd: number; usd: number; ngn: number; perTool: { tool: string; name: string; uses: number; gd: number }[] }
  antseed: { putInUsd: number; recoupedUsd: number; recoupedPct: number | null; stillOwedUsd: number; topups: { id: number; amountUsd: number; note: string; createdAt: number }[] }
  bills: { count: number; gd: number; ngn: number }
}

const KEY_STORE = 'jara_admin_key'
const usd = (n: number) => `$${n < 1 ? n.toFixed(4) : n.toFixed(2)}`
const gd = (n: number) => `G$ ${Math.round(n).toLocaleString()}`
const ngn = (n: number) => `₦${Math.round(n).toLocaleString()}`

function readKey(): string {
  try {
    return localStorage.getItem(KEY_STORE) ?? ''
  } catch {
    return ''
  }
}

export function TreasuryClient() {
  const [key, setKey] = useState('')
  const [draftKey, setDraftKey] = useState('')
  const [report, setReport] = useState<Report | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [amount, setAmount] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)

  const call = useCallback(
    async (k: string, body?: unknown) => {
      setBusy(true)
      setError(null)
      try {
        const res = await fetch('/api/admin/treasury', {
          method: body ? 'POST' : 'GET',
          headers: { authorization: `Bearer ${k}`, 'content-type': 'application/json' },
          body: body ? JSON.stringify(body) : undefined,
        })
        const json = await res.json()
        if (!res.ok) throw new Error(json.error ?? 'Request failed')
        setReport(json as Report)
        return true
      } catch (err) {
        setError(err instanceof Error ? err.message : 'Request failed')
        return false
      } finally {
        setBusy(false)
      }
    },
    [],
  )

  useEffect(() => {
    const k = readKey()
    if (!k) return
    // Restoring a saved key from browser storage once on mount.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setKey(k)
    void call(k)
  }, [call])

  const signIn = async () => {
    if (await call(draftKey)) {
      setKey(draftKey)
      try {
        localStorage.setItem(KEY_STORE, draftKey)
      } catch {}
    }
  }

  if (!key || !report) {
    return (
      <main className="grid min-h-screen place-items-center bg-forest px-4">
        <div className="w-full max-w-sm rounded-3xl border-[4px] border-ink bg-cream p-6 shadow-chunk-lg">
          <span className="grid h-11 w-11 place-items-center rounded-xl border-[3px] border-ink bg-crest">
            <Icon name="coins" className="h-6 w-6" />
          </span>
          <h1 className="mt-4 text-2xl font-extrabold">Jara treasury</h1>
          <p className="mt-1 text-sm font-semibold text-ink/60">Operator only. Enter the ADMIN_KEY from the server env.</p>
          <input
            type="password"
            value={draftKey}
            onChange={(e) => setDraftKey(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && signIn()}
            placeholder="Admin key"
            className="mt-4 w-full rounded-xl border-2 border-ink/20 bg-white px-4 py-3 font-semibold outline-none focus:border-ink"
          />
          {error && <p className="mt-2 text-sm font-bold text-red-700">{error}</p>}
          <button onClick={signIn} disabled={busy || !draftKey} className="press mt-4 w-full rounded-xl border-[3px] border-ink bg-mandarin py-3 font-extrabold shadow-chunk-sm disabled:opacity-50">
            {busy ? 'Checking…' : 'Open'}
          </button>
        </div>
      </main>
    )
  }

  const { ai, antseed, bills, rates } = report
  const pct = Math.min(100, antseed.recoupedPct ?? 0)

  return (
    <main className="min-h-screen bg-cream pb-16">
      <header className="border-b-[4px] border-ink bg-forest text-cream">
        <div className="mx-auto flex max-w-5xl items-center justify-between px-4 py-4 sm:px-6">
          <p className="flex items-center gap-2 text-xl font-extrabold">
            <span className="grid h-9 w-9 place-items-center rounded-xl border-[3px] border-ink bg-crest text-ink">
              <Icon name="coins" className="h-5 w-5" />
            </span>
            Treasury
          </p>
          <button onClick={() => call(key)} className="rounded-full bg-cream/10 px-4 py-2 text-sm font-bold hover:bg-cream/20">
            {busy ? 'Refreshing…' : 'Refresh'}
          </button>
        </div>
      </header>

      <div className="mx-auto grid max-w-5xl gap-6 px-4 pt-8 sm:px-6">
        {/* Recoup */}
        <section className="overflow-hidden rounded-[2rem] border-[4px] border-ink bg-white shadow-chunk">
          <div className="bg-mandarin px-6 py-5">
            <p className="text-xs font-extrabold tracking-widest uppercase opacity-60">AntSeed: paid back by G$</p>
            <p className="mt-1 text-4xl font-extrabold sm:text-5xl">{antseed.recoupedPct === null ? '—' : `${antseed.recoupedPct}%`}</p>
            <div className="mt-4 h-4 overflow-hidden rounded-full border-[3px] border-ink bg-cream">
              <div className="h-full bg-forest transition-all" style={{ width: `${pct}%` }} />
            </div>
          </div>
          <div className="grid grid-cols-2 divide-ink/10 sm:grid-cols-3 sm:divide-x">
            <Stat label="You put in" value={usd(antseed.putInUsd)} sub="USDC on AntSeed" />
            <Stat label="G$ paid back" value={usd(antseed.recoupedUsd)} sub={`${gd(ai.gd)} at today’s rate`} />
            <Stat label="Still to recoup" value={usd(antseed.stillOwedUsd)} sub={antseed.stillOwedUsd ? 'Cash out G$ when you’re ready' : 'All paid back'} />
          </div>
        </section>

        <div className="grid gap-6 lg:grid-cols-2">
          {/* AI usage */}
          <section className="rounded-[2rem] border-[4px] border-ink bg-white p-6 shadow-chunk">
            <h2 className="flex items-center gap-2 text-xl font-extrabold">
              <Icon name="sparkle" className="h-5 w-5" /> AI helpers
            </h2>
            <p className="mt-1 text-sm font-semibold text-ink/55">
              {ai.uses.toLocaleString()} paid uses by {ai.users.toLocaleString()} people · {gd(ai.gd)} ≈ {ngn(ai.ngn)}
            </p>
            {ai.perTool.length ? (
              <ul className="mt-4 grid gap-2">
                {ai.perTool.map((t) => (
                  <li key={t.tool} className="flex items-center justify-between rounded-xl bg-cream/70 px-4 py-2.5 text-sm">
                    <span className="font-bold">{t.name}</span>
                    <span className="font-semibold text-ink/60">
                      {t.uses}× · <span className="font-extrabold text-ink">{gd(t.gd)}</span>
                    </span>
                  </li>
                ))}
              </ul>
            ) : (
              <p className="mt-4 rounded-xl bg-cream/70 px-4 py-6 text-center text-sm font-semibold text-ink/50">No paid AI uses yet. Demo previews aren’t counted.</p>
            )}
          </section>

          {/* Top-ups */}
          <section className="rounded-[2rem] border-[4px] border-ink bg-white p-6 shadow-chunk">
            <h2 className="flex items-center gap-2 text-xl font-extrabold">
              <Icon name="coins" className="h-5 w-5" /> USDC you’ve put into AntSeed
            </h2>
            <p className="mt-1 text-sm font-semibold text-ink/55">Log each deposit so you know what G$ owes you back.</p>
            <div className="mt-4 flex gap-2">
              <input
                value={amount}
                onChange={(e) => setAmount(e.target.value.replace(/[^\d.]/g, ''))}
                inputMode="decimal"
                placeholder="USDC"
                className="w-24 rounded-xl border-2 border-ink/20 px-3 py-2.5 font-semibold outline-none focus:border-ink"
              />
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="Note (optional)"
                className="min-w-0 flex-1 rounded-xl border-2 border-ink/20 px-3 py-2.5 font-semibold outline-none focus:border-ink"
              />
              <button
                disabled={busy || !Number(amount)}
                onClick={async () => {
                  if (await call(key, { amountUsd: Number(amount), note })) {
                    setAmount('')
                    setNote('')
                  }
                }}
                className="press shrink-0 rounded-xl border-[3px] border-ink bg-crest px-4 font-extrabold shadow-chunk-sm disabled:opacity-50"
              >
                Add
              </button>
            </div>
            {error && <p className="mt-2 text-sm font-bold text-red-700">{error}</p>}
            <ul className="mt-4 grid gap-2">
              {antseed.topups.map((t) => (
                <li key={t.id} className="flex items-center justify-between gap-3 rounded-xl bg-cream/70 px-4 py-2.5 text-sm">
                  <span className="min-w-0">
                    <span className="font-extrabold">{usd(t.amountUsd)}</span>
                    <span className="ml-2 font-semibold text-ink/55">{new Date(t.createdAt).toLocaleDateString()}</span>
                    {t.note && <span className="ml-2 truncate font-semibold text-ink/55">· {t.note}</span>}
                  </span>
                  <button onClick={() => call(key, { deleteId: t.id })} className="shrink-0 text-ink/40 hover:text-ink" aria-label="Remove">
                    <Icon name="x" className="h-4 w-4" strokeWidth={3} />
                  </button>
                </li>
              ))}
              {!antseed.topups.length && <li className="rounded-xl bg-cream/70 px-4 py-6 text-center text-sm font-semibold text-ink/50">Nothing logged yet.</li>}
            </ul>
          </section>
        </div>

        {/* Context */}
        <section className="grid gap-4 rounded-[2rem] border-[4px] border-ink bg-forest p-6 text-cream shadow-chunk sm:grid-cols-3">
          <div>
            <p className="text-xs font-extrabold tracking-widest text-cream/50 uppercase">Bills paid with G$</p>
            <p className="mt-1 text-2xl font-extrabold">{bills.count.toLocaleString()}</p>
            <p className="text-sm font-semibold text-cream/60">
              {gd(bills.gd)} in · {ngn(bills.ngn)} out via VTpass
            </p>
          </div>
          <div>
            <p className="text-xs font-extrabold tracking-widest text-cream/50 uppercase">G$ price</p>
            <p className="mt-1 text-2xl font-extrabold">${rates.usdPerGd.toPrecision(3)}</p>
            <p className="text-sm font-semibold text-cream/60">₦{rates.ngnPerGd.toPrecision(3)} per G$</p>
          </div>
          <div>
            <p className="text-xs font-extrabold tracking-widest text-cream/50 uppercase">Check AntSeed spend</p>
            <p className="mt-1 font-mono text-sm font-bold text-crest">antseed buyer metering</p>
            <p className="text-sm font-semibold text-cream/60">Shows tokens used and USDC settled per peer.</p>
          </div>
        </section>
      </div>
    </main>
  )
}

function Stat({ label, value, sub }: { label: string; value: string; sub: string }) {
  return (
    <div className="border-t-2 border-ink/10 px-6 py-4 sm:border-t-0">
      <p className="text-xs font-extrabold tracking-widest text-ink/45 uppercase">{label}</p>
      <p className="mt-1 text-2xl font-extrabold">{value}</p>
      <p className="text-xs font-semibold text-ink/50">{sub}</p>
    </div>
  )
}
