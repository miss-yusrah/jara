'use client'

import { useCallback, useEffect, useState } from 'react'
import { createPublicClient, createWalletClient, custom, type Address, type Hex } from 'viem'
import { celo } from 'viem/chains'
import { challengeAbi, type ChallengeView } from '@/lib/daily-challenge-shared'
import { readApiResponse } from '@/lib/api-response'
import { getWalletProvider } from '@/lib/web3auth'
import { walletErrorMessage } from '@/lib/wallet-connect'
import { NETWORKS, NETWORK_INFO } from '@/lib/catalog'
import { Icon } from './Icon'

async function request<T>(body?: unknown): Promise<T> {
  return readApiResponse<T>(
    await fetch(
      '/api/challenges',
      body
        ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) }
        : { cache: 'no-store' },
    ),
  )
}
const short = (address: string) => `${address.slice(0, 6)}…${address.slice(-4)}`

export function DailyChallenge({ rootAddress }: { rootAddress: string | null }) {
  const [view, setView] = useState<ChallengeView | null>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState('')
  const [started, setStarted] = useState<number | null>(null)
  const [answers, setAnswers] = useState<{ day: number; values: number[] }>({ day: 0, values: [] })
  const [reviewed, setReviewed] = useState<number | null>(null)
  const [hash, setHash] = useState<Hex | null>(null)
  const [showRules, setShowRules] = useState(false)
  const refresh = useCallback(async () => {
    const result = await request<ChallengeView>()
    setView(result)
    return result
  }, [])
  useEffect(() => {
    let alive = true
    const load = () => {
      void request<ChallengeView>()
        .then((result) => {
          if (alive) setView(result)
        })
        .catch(() => {
          if (alive) setError('Could not load Daily Jara. Try refreshing below.')
        })
    }
    load()
    const interval = window.setInterval(load, 60_000)
    window.addEventListener('focus', load)
    return () => {
      alive = false
      window.clearInterval(interval)
      window.removeEventListener('focus', load)
    }
  }, [rootAddress])

  const act = async (label: string, fn: () => Promise<void>) => {
    setBusy(label)
    setError('')
    try {
      await fn()
    } catch (err) {
      setError(walletErrorMessage(err))
    } finally {
      setBusy('')
    }
  }
  const enter = () =>
    act('Opening your wallet…', async () => {
      if (!view || !rootAddress) return
      const current = await refresh()
      if (current.entered) return
      if (current.day !== view.day) throw new Error('A new day has started. Complete today’s challenge to enter.')
      const provider = await getWalletProvider()
      const wallet = createWalletClient({ chain: celo, transport: custom(provider) })
      const [account] = await wallet.requestAddresses()
      if (!account || account.toLowerCase() !== rootAddress.toLowerCase())
        throw new Error('Switch to the verified wallet connected to your Jara account.')
      await wallet.switchChain({ id: celo.id }).catch(() => wallet.addChain({ chain: celo }))
      // Reads use the selected wallet's Celo transport; no server-owned sender or relay.
      const pub = createPublicClient({ chain: celo, transport: custom(provider) })
      const pendingKey = `jara:daily-entry:${current.contract}:${account.toLowerCase()}:${current.day}`
      let pending: Hex | null = null
      try {
        const saved = localStorage.getItem(pendingKey)
        if (saved && /^0x[0-9a-fA-F]{64}$/.test(saved)) pending = saved as Hex
      } catch {
        /* storage may be unavailable */
      }
      if (!pending) {
        const ticket = await request<{ contract: Address; day: number; challengeId: Hex; signature: Hex }>({
          action: 'prepare',
          day: current.day,
          reviewed: true,
        })
        const { request: transaction } = await pub.simulateContract({
          account,
          address: ticket.contract,
          abi: challengeAbi,
          functionName: 'enter',
          args: [BigInt(ticket.day), ticket.challengeId, ticket.signature],
        })
        setBusy('Confirm your entry in your wallet…')
        pending = await wallet.writeContract(transaction)
        try {
          localStorage.setItem(pendingKey, pending)
        } catch {
          /* contract still prevents duplicate entries */
        }
      }
      setHash(pending)
      setBusy('Waiting for your entry to confirm…')
      const receipt = await pub.waitForTransactionReceipt({ hash: pending, timeout: 60_000 })
      try {
        localStorage.removeItem(pendingKey)
      } catch {
        /* harmless */
      }
      if (receipt.status !== 'success')
        throw new Error('The entry transaction reverted. You can try again while entries are open.')
      const confirmed = await refresh()
      if (!confirmed.entered && confirmed.day === current.day)
        throw new Error('Your transaction confirmed. Refresh shortly while the app catches up.')
    })

  if (!view)
    return (
      <section className="app-card mb-6 p-6" aria-label="Daily Jara">
        <p className="font-bold text-forest">Daily Jara</p>
        <p className="mt-2 text-sm text-ink/60" role="status">
          {error || 'Loading today’s challenge…'}
        </p>
        {error && (
          <button
            className="app-button-secondary mt-3"
            onClick={() =>
              act('Refreshing…', async () => {
                await refresh()
              })
            }
          >
            Try again
          </button>
        )}
      </section>
    )
  const values = answers.day === view.day ? answers.values : []
  const playing = started === view.day || Boolean(view.review)
  return (
    <section
      className="mb-6 overflow-hidden rounded-[24px] border border-forest/15 bg-white"
      aria-labelledby="daily-jara-title"
    >
      <div className="relative overflow-hidden bg-forest px-5 py-6 text-cream sm:px-7">
        <div className="pointer-events-none absolute -top-12 -right-10 h-52 w-52 rounded-full border-[30px] border-cream/5" />
        <div className="relative flex flex-wrap items-center justify-between gap-3">
          <p className="text-[11px] font-bold tracking-[0.16em] text-crest uppercase">Daily Jara · {view.date}</p>
          <span className="flex items-center gap-1.5 rounded-full bg-cream/10 px-3 py-1.5 text-xs font-semibold">
            <Icon name="flame" className="h-4 w-4 text-crest" />
            {view.streak}-day activity streak
          </span>
        </div>
        <h2
          id="daily-jara-title"
          className="relative mt-4 max-w-xl text-[28px] leading-tight font-bold tracking-tight sm:text-[34px]"
        >
          {view.entered
            ? 'You’re in. See you tomorrow.'
            : view.available
              ? 'A little knowledge. A chance to win.'
              : 'A little reason to come back.'}
        </h2>
        <p className="relative mt-3 max-w-xl text-sm leading-relaxed text-cream/75">
          {view.available || view.entered
            ? 'Five ₦1,000 airtime prizes. Three quick questions. One chance each day.'
            : view.reason}
        </p>
        {view.week.length > 0 && (
          <ol className="relative mt-5 flex gap-2" aria-label="Your activity this week, Monday to Sunday">
            {view.week.map((day, i) => (
              <li
                key={i}
                aria-label={`${['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'][i]}${day.today ? ', today' : ''}: ${day.entered ? 'entry confirmed' : 'no entry'}`}
                className={`grid h-10 w-10 place-items-center rounded-xl text-xs font-bold ${day.entered ? 'bg-crest text-forest' : day.today ? 'border-2 border-crest text-crest' : 'bg-cream/10 text-cream/55'}`}
              >
                {day.entered ? '✓' : day.label}
              </li>
            ))}
          </ol>
        )}
      </div>
      <div className="p-5 sm:p-7">
        <div role="status" aria-live="polite">
          {busy && <p className="mb-4 text-sm font-semibold text-forest">{busy}</p>}
        </div>
        {error && (
          <div role="alert" className="mb-4 rounded-xl bg-orange-50 p-3 text-sm text-orange-900">
            {error}
            <button
              className="ml-2 underline"
              disabled={Boolean(busy)}
              onClick={() =>
                act('Refreshing…', async () => {
                  await refresh()
                })
              }
            >
              Refresh status
            </button>
          </div>
        )}
        {view.entered ? (
          <div className="flex items-start gap-3">
            <span className="grid h-10 w-10 shrink-0 place-items-center rounded-full bg-crest text-forest">✓</span>
            <div>
              <h3 className="font-bold text-forest">Today’s entry is confirmed</h3>
              <p className="mt-1 text-sm text-ink/60">
                Your wallet is in today’s draw. A fresh challenge opens at midnight Lagos time.
              </p>
              {hash && (
                <a
                  href={`https://celoscan.io/tx/${hash}`}
                  target="_blank"
                  rel="noreferrer"
                  className="mt-2 inline-block text-xs font-semibold text-forest underline"
                >
                  View your transaction ↗
                </a>
              )}
            </div>
          </div>
        ) : (
          view.available && (
            <>
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <h3 className="text-lg font-bold tracking-tight">{view.title}</h3>
                  <p className="mt-1 text-xs text-ink/55">
                    About 1 minute · No purchase · {view.entryCount} {view.entryCount === 1 ? 'entry' : 'entries'} today
                  </p>
                </div>
                {!playing && (
                  <button
                    className="app-button bg-crest text-ink hover:bg-crest-soft"
                    onClick={() => setStarted(view.day)}
                  >
                    Start today’s challenge <Icon name="arrow" className="h-4 w-4" />
                  </button>
                )}
              </div>
              {playing && (
                <form
                  className="mt-6 space-y-5"
                  onSubmit={(e) => {
                    e.preventDefault()
                    void act('Checking your answers…', async () => {
                      const result = await request<{ review: ChallengeView['review'] }>({
                        action: 'submit',
                        day: view.day,
                        answers: values,
                      })
                      setView((old) => (old && old.day === view.day ? { ...old, review: result.review } : old))
                    })
                  }}
                >
                  {view.questions.map((question, i) => (
                    <fieldset key={`${view.day}:${i}`} disabled={Boolean(view.review) || Boolean(busy)}>
                      <legend className="mb-3 text-sm font-semibold">
                        {i + 1}. {question.prompt}
                      </legend>
                      <div className="grid gap-2">
                        {question.options.map((option, j) => (
                          <label
                            key={j}
                            className={`flex cursor-pointer items-start gap-3 rounded-xl border px-4 py-3 text-sm ${view.review?.[i].correctOption === j ? 'border-forest/30 bg-forest/5' : 'border-ink/10 hover:bg-ink/[0.02]'}`}
                          >
                            <input
                              type="radio"
                              name={`daily-${view.day}-${i}`}
                              value={j}
                              checked={(view.review?.[i].selected ?? values[i]) === j}
                              onChange={() =>
                                setAnswers((old) => {
                                  const next = old.day === view.day ? [...old.values] : []
                                  next[i] = j
                                  return { day: view.day, values: next }
                                })
                              }
                              className="mt-0.5 accent-forest"
                              required
                            />
                            <span>
                              {option}
                              {view.review?.[i].correctOption === j && (
                                <span className="ml-2 text-xs font-bold text-forest">Correct answer</span>
                              )}
                            </span>
                          </label>
                        ))}
                      </div>
                      {view.review && (
                        <p className="mt-3 text-sm leading-relaxed text-ink/65">{view.review[i].explanation}</p>
                      )}
                    </fieldset>
                  ))}
                  {!view.review && (
                    <button
                      type="submit"
                      disabled={Boolean(busy) || view.questions.some((_, i) => values[i] === undefined)}
                      className="app-button bg-forest text-cream disabled:opacity-50"
                    >
                      Review my answers
                    </button>
                  )}
                </form>
              )}
              {view.review && (
                <div className="mt-6 rounded-2xl bg-[#f4f5ef] p-4">
                  <p className="text-sm font-bold text-forest">You’ve learned something. Now make it count.</p>
                  <p className="mt-2 text-sm text-ink/65">
                    All completed challenges qualify, whatever your score. No G$ is charged. Your wallet will show the
                    Celo network fee before you confirm.
                  </p>
                  <label className="mt-4 flex items-start gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="mt-1 accent-forest"
                      checked={reviewed === view.day}
                      onChange={(e) => setReviewed(e.target.checked ? view.day : null)}
                    />
                    I’ve reviewed the explanations and the draw rules below.
                  </label>
                  <button
                    disabled={Boolean(busy) || reviewed !== view.day}
                    onClick={enter}
                    className="app-button mt-4 bg-forest text-cream disabled:opacity-50"
                  >
                    Enter today’s draw <Icon name="arrow" className="h-4 w-4" />
                  </button>
                  {hash && (
                    <a
                      href={`https://celoscan.io/tx/${hash}`}
                      target="_blank"
                      rel="noreferrer"
                      className="ml-3 text-xs text-forest underline"
                    >
                      Check transaction ↗
                    </a>
                  )}
                </div>
              )}
            </>
          )
        )}
        {view.prizes.map((prize) => (
          <Prize key={prize.day} prize={prize} refresh={refresh} />
        ))}
        {view.results.length > 0 && (
          <div className="mt-6 border-t border-ink/10 pt-5">
            <h3 className="text-sm font-bold">Recent draws</h3>
            <div className="mt-3 grid gap-3">
              {view.results.map((result) => (
                <div key={result.day} className="rounded-xl bg-[#f4f5ef] p-3 text-xs">
                  <div className="flex justify-between gap-3">
                    <span className="font-semibold">
                      {result.date} · {result.entrants} entries
                    </span>
                    <a
                      className="text-forest underline"
                      href={`/api/challenges/results?day=${result.day}`}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Draw record ↗
                    </a>
                  </div>
                  <p className="mt-2 text-ink/65">
                    {result.winners.length
                      ? result.winners
                          .map((winner) => `${short(winner.wallet)}${winner.delivered ? ' ✓ delivered' : ' · won'}`)
                          .join(' / ')
                      : 'No entries. No prizes awarded.'}
                  </p>
                </div>
              ))}
            </div>
          </div>
        )}
        <div className="mt-5 border-t border-ink/10 pt-4">
          <button
            className="text-xs font-bold text-forest underline"
            onClick={() => setShowRules(!showRules)}
            aria-expanded={showRules}
          >
            How the draw works
          </button>
          {showRules && (
            <div className="mt-3 space-y-2 text-xs leading-relaxed text-ink/60">
              <p>
                Complete all three questions, review the explanations, then confirm your entry from your
                GoodDollar-verified root wallet. One entry per verified person per Lagos day. Entries close at midnight
                (UTC+1). A perfect score is not required. Streak length does not change your odds.
              </p>
              <p>
                Jara runs the draw within 24 hours after entries close, using a server-generated random seed. Up to five
                different entrants receive ₦1,000 airtime each; if fewer than five enter, every entrant wins ₦1,000.
                Unawarded prizes do not roll over. This is an operator-run draw, not on-chain verifiable randomness.
              </p>
              <p>
                Winners appear here and submit a Nigerian phone number and network. Jara delivers airtime manually
                within 48 hours of receiving these details. Phone numbers are private. No purchase or G$ transfer is
                required; entering does incur the network fee displayed by your wallet. Only a successful contract entry
                qualifies. Prizes are not guaranteed for participation.
              </p>
              <p>
                Missing a day resets your activity streak, but preserves past entries and prizes. Automatic G$ claims do
                not count toward this streak. Technical failures before confirmation do not create an entry.
              </p>
              {view.contract && (
                <p>
                  <a
                    href={`https://celoscan.io/address/${view.contract}`}
                    target="_blank"
                    rel="noreferrer"
                    className="text-forest underline"
                  >
                    View the entry contract ↗
                  </a>
                </p>
              )}
            </div>
          )}
        </div>
      </div>
    </section>
  )
}

function Prize({ prize, refresh }: { prize: ChallengeView['prizes'][number]; refresh: () => Promise<unknown> }) {
  const [phone, setPhone] = useState('')
  const [network, setNetwork] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  return (
    <div className="mt-5 rounded-2xl border border-forest/20 bg-crest/15 p-4">
      <h3 className="font-bold text-forest">You won ₦1,000 airtime · {prize.date}</h3>
      {prize.delivered ? (
        <p className="mt-2 text-sm">Delivered to {prize.phone}. Enjoy your airtime!</p>
      ) : prize.phone ? (
        <p className="mt-2 text-sm">
          Your {prize.network} number {prize.phone} is saved. Delivery is due within 48 hours of submitting it.
        </p>
      ) : (
        <form
          className="mt-3 grid gap-3 sm:grid-cols-2"
          onSubmit={async (e) => {
            e.preventDefault()
            setBusy(true)
            setError('')
            try {
              await request({ action: 'prize', day: prize.day, phone, network })
              await refresh()
            } catch (err) {
              setError(walletErrorMessage(err))
            } finally {
              setBusy(false)
            }
          }}
        >
          <label className="text-xs font-semibold">
            Nigerian phone number
            <input
              type="tel"
              inputMode="tel"
              autoComplete="tel-national"
              pattern="0[789][0-9]{9}"
              maxLength={11}
              required
              value={phone}
              onChange={(e) => setPhone(e.target.value)}
              placeholder="08012345678"
              className="mt-1 block w-full rounded-xl border border-ink/15 bg-white p-3 text-sm"
            />
          </label>
          <label className="text-xs font-semibold">
            Network
            <select
              required
              value={network}
              onChange={(e) => setNetwork(e.target.value)}
              className="mt-1 block w-full rounded-xl border border-ink/15 bg-white p-3 text-sm"
            >
              <option value="">Choose network</option>
              {NETWORKS.map((n) => (
                <option key={n} value={n}>
                  {NETWORK_INFO[n].label}
                </option>
              ))}
            </select>
          </label>
          <p className="text-xs text-ink/60 sm:col-span-2">
            Double-check these details. They cannot be changed after submission.
          </p>
          {error && (
            <p role="alert" className="text-sm text-red-700 sm:col-span-2">
              {error}
            </p>
          )}
          <button disabled={busy} className="app-button justify-center bg-forest text-cream disabled:opacity-50">
            {busy ? 'Saving…' : 'Confirm airtime recipient'}
          </button>
        </form>
      )}
    </div>
  )
}
