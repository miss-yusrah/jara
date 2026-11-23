'use client'

import Link from 'next/link'
import { useState } from 'react'
import { readApiResponse } from '@/lib/api-response'

interface Report {
  campaign: {
    contract: string
    start: string
    end: string
    enabled: boolean
    paused: boolean
    budgetNgn: number
  } | null
  days: { day: number; date: string; closed: boolean; drawn: boolean }[]
  winners: {
    day: number
    root: string
    rank: number
    phone: string | null
    network: string | null
    recipient_at: number | null
    delivery_ref: string | null
    delivered_at: number | null
  }[]
}

export function ChallengeAdmin() {
  const [key, setKey] = useState('')
  const [report, setReport] = useState<Report | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const [receipts, setReceipts] = useState<Record<string, string>>({})
  const request = async (body?: unknown) => {
    const res = await fetch('/api/admin/challenges', {
      method: body ? 'POST' : 'GET',
      cache: 'no-store',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
    return readApiResponse<Report>(res)
  }
  const act = async (body?: unknown) => {
    setBusy(true)
    setError('')
    try {
      if (body) await request(body)
      setReport(await request())
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Request failed. Retry to check the saved result.')
    } finally {
      setBusy(false)
    }
  }
  return (
    <main className="jara-app min-h-screen px-4 py-10 text-ink">
      <div className="mx-auto max-w-4xl">
        <Link href="/app" className="text-sm font-bold text-forest">
          ← Back to Jara
        </Link>
        <h1 className="mt-6 text-3xl font-bold tracking-tight">Daily Jara campaign</h1>
        <p className="mt-3 text-sm text-ink/60">
          Run closed-day draws and record airtime delivery. Each draw is saved once; retrying returns the existing
          result.
        </p>
        <form
          className="mt-6 flex flex-wrap gap-3"
          onSubmit={(e) => {
            e.preventDefault()
            void act()
          }}
        >
          <label className="sr-only" htmlFor="campaign-admin-key">
            Admin key
          </label>
          <input
            id="campaign-admin-key"
            type="password"
            value={key}
            onChange={(e) => setKey(e.target.value)}
            placeholder="Admin key"
            autoComplete="off"
            required
            className="rounded-xl border border-ink/15 bg-white p-3"
          />
          <button disabled={busy} className="app-button bg-forest text-cream disabled:opacity-50">
            {busy ? 'Working…' : 'Load / refresh campaign'}
          </button>
        </form>
        {error && (
          <p role="alert" className="mt-4 rounded-xl bg-red-50 p-4 text-sm text-red-800">
            {error}
          </p>
        )}
        {report &&
          (!report.campaign ? (
            <p className="app-card mt-6 p-6">
              No live contract configured. Follow docs/daily-challenge.md to deploy and fund a campaign before enabling
              it.
            </p>
          ) : (
            <>
              <section className="app-card mt-6 p-6">
                <h2 className="font-bold">
                  {report.campaign.start} → {report.campaign.end}
                </h2>
                <p className="mt-2 text-sm">
                  Budget required: ₦{report.campaign.budgetNgn.toLocaleString()} · Up to five ₦1,000 prizes each day
                </p>
                <p className="mt-2 text-sm">
                  {report.campaign.enabled && !report.campaign.paused
                    ? 'App entries enabled'
                    : 'App entries paused or disabled'}
                </p>
                <a
                  className="mt-2 block break-all text-xs text-forest underline"
                  href={`https://celoscan.io/address/${report.campaign.contract}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {report.campaign.contract}
                </a>
                <p className="mt-3 text-xs leading-relaxed text-ink/60">
                  Airtime funding is held outside the contract. Opening a campaign is an operator commitment to fund and
                  deliver its prizes. Disabling app entries does not invalidate already-issued tickets; use the
                  contract’s pause function to stop those too.
                </p>
              </section>
              <section className="app-card mt-5 p-6">
                <h2 className="font-bold">Draws</h2>
                <p className="mt-2 text-xs text-ink/60">
                  Draw after midnight Lagos time and within 24 hours of closing. Participants come from a finalized
                  on-chain snapshot. Randomness is generated by the server; this is not a VRF draw.
                </p>
                <div className="mt-4 grid gap-2">
                  {report.days.map((day) => (
                    <div
                      key={day.day}
                      className="flex items-center justify-between gap-3 border-t border-ink/10 py-3 text-sm"
                    >
                      <span>{day.date}</span>
                      {day.drawn ? (
                        <a
                          href={`/api/challenges/results?day=${day.day}`}
                          target="_blank"
                          rel="noreferrer"
                          className="font-semibold text-forest underline"
                        >
                          Published result ↗
                        </a>
                      ) : (
                        <button
                          className="app-button-secondary disabled:opacity-40"
                          disabled={busy || !day.closed}
                          onClick={() => act({ action: 'draw', day: day.day })}
                        >
                          {day.closed ? 'Draw up to five winners' : 'Entries not closed'}
                        </button>
                      )}
                    </div>
                  ))}
                </div>
              </section>
              <section className="app-card mt-5 p-6">
                <h2 className="font-bold">Airtime delivery</h2>
                <p className="mt-2 text-xs leading-relaxed text-ink/60">
                  Winners submit their number in Daily Jara. Send ₦1,000 through your airtime provider within 48 hours
                  of submission, then record its successful receipt here. This panel does not send airtime or charge a
                  user. Never resend a pending provider order; reconcile its original reference.
                </p>
                {report.winners.length === 0 && <p className="mt-4 text-sm text-ink/50">No winners yet.</p>}
                <div className="mt-4 space-y-4">
                  {report.winners.map((winner) => {
                    const id = `${winner.day}:${winner.root}`
                    return (
                      <div key={id} className="rounded-xl border border-ink/10 p-4">
                        <p className="text-sm font-semibold">
                          {new Date(winner.day * 86_400_000).toISOString().slice(0, 10)} · Winner {winner.rank} · ₦1,000
                        </p>
                        <p className="mt-1 break-all text-xs text-ink/55">{winner.root}</p>
                        {winner.delivered_at ? (
                          <p className="mt-3 text-sm text-forest">Delivered · {winner.delivery_ref}</p>
                        ) : !winner.phone ? (
                          <p className="mt-3 text-sm text-ink/55">Waiting for recipient details</p>
                        ) : (
                          <>
                            <p className="mt-3 text-sm font-bold">
                              {winner.phone} · {winner.network}
                            </p>
                            {winner.recipient_at && (
                              <p className="mt-1 text-xs text-ink/60">
                                Deliver by{' '}
                                {new Date(winner.recipient_at + 48 * 60 * 60 * 1000).toLocaleString('en-NG', {
                                  timeZone: 'Africa/Lagos',
                                })}{' '}
                                Lagos time.
                              </p>
                            )}
                            <form
                              className="mt-3 flex flex-wrap gap-2"
                              onSubmit={(e) => {
                                e.preventDefault()
                                void act({
                                  action: 'delivered',
                                  day: winner.day,
                                  root: winner.root,
                                  reference: receipts[id],
                                })
                              }}
                            >
                              <input
                                aria-label={`Successful provider reference for ${winner.phone}`}
                                required
                                minLength={3}
                                maxLength={160}
                                placeholder="Successful provider receipt/reference"
                                value={receipts[id] ?? ''}
                                onChange={(e) => setReceipts((old) => ({ ...old, [id]: e.target.value }))}
                                className="min-w-0 flex-1 rounded-xl border border-ink/15 p-3 text-sm"
                              />
                              <button disabled={busy} className="app-button bg-forest text-cream disabled:opacity-50">
                                Record delivered airtime
                              </button>
                            </form>
                          </>
                        )}
                      </div>
                    )
                  })}
                </div>
              </section>
            </>
          ))}
      </div>
    </main>
  )
}
