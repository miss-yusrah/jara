'use client'

import Link from 'next/link'
import { useEffect, useState } from 'react'

// Jara Streak on the dashboard, in one spot: before it starts, a moving ticker (the announcement);
// from the start, the ticker is replaced by a card with a big flame and the time left; after it
// ends, the same card points to the results. Shown for three days after it ends.

export type StreakBannerState = {
  phase: 'soon' | 'open' | 'closed'
  startAt: number
  endAt: number
  prizePoolGd: number
  prizesGd: number[]
  winners: number
  perCorrectGd: number
  golden: { live: boolean; startsAt: number | null; endsAt: number | null }
}

function left(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000))
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60
  return d > 0 ? `${d}d ${h}h ${m}m` : `${h}h ${String(m).padStart(2, '0')}m ${String(sec).padStart(2, '0')}s`
}

function clock(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000))
  return { d: Math.floor(s / 86400), h: Math.floor((s % 86400) / 3600), m: Math.floor((s % 3600) / 60), s: s % 60 }
}
const pad = (n: number) => String(n).padStart(2, '0')

/** The moving announcement strip under the page heading. Shown before, during and after the bounty. */
function Ticker({ badge, live, items }: { badge: string; live: boolean; items: string[] }) {
  const line = items.join('   •   ')
  return (
    <Link href="/app/streak" className="group block overflow-hidden rounded-2xl bg-forest text-cream" aria-label={items[0]}>
      <div className="flex items-center gap-3 py-2.5 pr-3 pl-2.5">
        <span className="flex shrink-0 items-center gap-1.5 rounded-full bg-mandarin px-2.5 py-1 text-[10px] font-bold tracking-[0.12em] text-white uppercase">
          {live && <span className="streak-live h-1.5 w-1.5 rounded-full bg-white" />}{badge}
        </span>
        <div className="relative min-w-0 flex-1 overflow-hidden" aria-hidden>
          <div className="streak-ticker-track text-sm font-semibold text-cream/90">
            <span className="pr-16">{line}</span><span className="pr-16">{line}</span>
          </div>
        </div>
        <span className="shrink-0 text-xs font-bold text-crest">Open →</span>
      </div>
    </Link>
  )
}

export function StreakBanner({ streak }: { streak?: StreakBannerState }) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => { const id = window.setInterval(() => setNow(Date.now()), 1000); return () => window.clearInterval(id) }, [])
  if (!streak) return null
  const phase = now >= streak.endAt ? 'closed' : now >= streak.startAt ? 'open' : 'soon'
  if (phase === 'closed' && now > streak.endAt + 3 * 86_400_000) return null
  const pool = `G$ ${streak.prizePoolGd.toLocaleString('en-US')} prize pool for the top ${streak.winners}`
  const perCorrect = streak.perCorrectGd > 0 ? `G$ ${streak.perCorrectGd} for every correct answer` : null
  const golden = Boolean(streak.golden.live && streak.golden.endsAt && now < streak.golden.endsAt)
  const goldenSoon = !golden && streak.golden.startsAt && streak.golden.startsAt > now ? streak.golden.startsAt - now : null

  if (phase === 'soon') {
    return <Ticker badge="Soon" live={false} items={[`Jara Streak, the campus bounty, starts in ${left(streak.startAt - now)}`, pool, ...(perCorrect ? [perCorrect] : []), 'Invite your friends for extra runs']} />
  }
  // From the start the ticker is gone; this card takes its place. While live it counts down to the
  // end; afterwards it points to the results (and the winners' claim).
  const closed = phase === 'closed'
  const c = clock(streak.endAt - now)
  const unit = 'ml-0.5 mr-2 text-sm font-medium text-cream/50'
  return (
    <Link href="/app/streak" className="group streak-rings relative block overflow-hidden rounded-[22px] bg-forest text-cream">
        <div className="relative z-10 flex flex-wrap items-center gap-x-6 gap-y-4 px-5 py-5 sm:px-7">
          <span aria-hidden className="streak-flame text-[44px] leading-none">🔥</span>
          <div className="min-w-0 flex-1">
            <p className="flex items-center gap-1.5 text-[11px] font-bold tracking-[0.14em] text-crest uppercase">
              {!closed && <span className="streak-live h-2 w-2 rounded-full bg-mandarin" />}
              {closed ? 'Ended' : golden ? 'Golden Hour · double points' : goldenSoon ? `Live · Golden Hour in ${left(goldenSoon)}` : 'Live now'}
            </p>
            <p className="mt-1 text-[22px] leading-tight font-semibold tracking-[-0.03em]">Jara Streak</p>
            <p className="mt-0.5 truncate text-sm text-cream/60">{closed ? 'See the winners. Top 3: claim your prize.' : `${pool}${perCorrect ? ` · ${perCorrect}` : ''}`}</p>
          </div>
          {!closed && (
            <div className="tabular-nums">
              <p className="text-[11px] font-semibold text-cream/55">Ends in</p>
              <p className="mt-0.5 text-[28px] leading-none font-semibold tracking-[-0.04em]">
                {c.d > 0 && <>{c.d}<span className={unit}>d</span></>}{pad(c.h)}<span className={unit}>h</span>{pad(c.m)}<span className={unit}>m</span>{pad(c.s)}<span className="ml-0.5 text-sm font-medium text-cream/50">s</span>
              </p>
            </div>
          )}
          <span className="w-full rounded-xl bg-mandarin px-6 py-3 text-center text-sm font-bold text-white transition group-hover:bg-mandarin-deep sm:w-auto">{closed ? 'See results' : 'Play now'}</span>
        </div>
    </Link>
  )
}
