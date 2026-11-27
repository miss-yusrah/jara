'use client'

import Link from 'next/link'
import { useCallback, useEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { ApiError, readApiResponse, responseMessage } from '@/lib/api-response'
import { CAMPUSES } from '@/lib/streak/campuses'
import { multiplier } from '@/lib/streak/rules'
import type { StreakBoard, StreakHome, StreakRunView } from '@/lib/streak/service'
import { Icon, type IconName } from './Icon'
import { StreakAudio } from './streak-audio'
import { useSheetDialog } from './useSheetDialog'

// Jara Streak, the campus bounty: how many can you get right in a row? Two answers, one is right,
// the clock gets shorter as the streak grows, one miss ends the run. The best run counts; the top 3
// when it ends win a G$ prize each (STREAK_PRIZE_GD). The server keeps the clock and the score; this screen plays.

type Result = { correct: boolean; timedOut: boolean; correctChoice: number | null; points: number; golden: boolean; newBest: boolean; gd: number; gdNote: 'daily_cap' | 'pool_empty' | null }
type Float = { key: number; points: number; gd: number; streak: number; golden: boolean }
type Reveal = { run: StreakRunView; choice: number | null; correctChoice: number | null }

async function request<T>(url: string, body?: object): Promise<T> {
  const res = await fetch(url, body ? { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : { cache: 'no-store' })
    .catch(() => { throw new ApiError('The connection dropped. Check your network and try again.', 'network', 0, true) })
  return readApiResponse<T>(res)
}

const lagos = (ms: number, opts: Intl.DateTimeFormatOptions) => new Intl.DateTimeFormat('en-NG', { timeZone: 'Africa/Lagos', ...opts }).format(ms)
const when = (ms: number) => lagos(ms, { weekday: 'short', day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })
const num = (n: number) => n.toLocaleString('en-US')
const MUTE_KEY = 'jara-streak-muted'

function parts(ms: number) {
  const s = Math.max(0, Math.floor(ms / 1000))
  return { d: Math.floor(s / 86400), h: Math.floor((s % 86400) / 3600), m: Math.floor((s % 3600) / 60), s: s % 60 }
}
function shortLeft(ms: number) {
  const p = parts(ms)
  return p.d > 0 ? `${p.d}d ${p.h}h` : p.h > 0 ? `${p.h}h ${p.m}m` : `${p.m}m ${String(p.s).padStart(2, '0')}s`
}

export function StreakGame() {
  const [home, setHome] = useState<StreakHome | null>(null)
  const [board, setBoard] = useState<StreakBoard | null>(null)
  const [run, setRun] = useState<StreakRunView | null>(null)
  const [reveal, setReveal] = useState<Reveal | null>(null)
  const [picked, setPicked] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [toast, setToast] = useState<string | null>(null)
  const [now, setNow] = useState(() => Date.now())
  const [skew, setSkew] = useState(0)
  // Only read once sound is on, so the first render matches the server's.
  const [muted, setMuted] = useState(() => { try { return typeof window !== 'undefined' && localStorage.getItem(MUTE_KEY) === '1' } catch { return false } })
  const [sound, setSound] = useState(false)
  const [float, setFloat] = useState<Float | null>(null)
  const capNoted = useRef(false)
  const [shake, setShake] = useState(0)
  const [glow, setGlow] = useState(0)
  const [bestThisRun, setBestThisRun] = useState(false)
  const [panel, setPanel] = useState<'how' | 'invite' | 'board' | null>(null)
  const closePanel = useCallback(() => {
    setPanel(null)
    if (window.location.search.includes('view=')) window.history.replaceState(null, '', window.location.pathname)
  }, [])
  const lock = useRef(false)
  const audio = useRef<StreakAudio | null>(null)
  const lastTick = useRef<number | null>(null)
  const lastRank = useRef<number | null>(null)

  const playing = Boolean(run && !run.finished && run.question && !reveal)

  // ---- loading ----
  const loadHome = useCallback(async () => {
    const h = await request<StreakHome>('/api/streak')
    setHome(h)
    setSkew(h.event.serverNow - Date.now())
    return h
  }, [])
  const loadBoard = useCallback(async () => {
    const b = await request<StreakBoard>('/api/streak/leaderboard').catch(() => null)
    if (!b) return
    setBoard(b)
    // Someone climbed past you: say so, by name when we can see them.
    const rank = b.you?.rank ?? null
    if (rank !== null && lastRank.current !== null && rank > lastRank.current) {
      const above = b.top[rank - 2]
      setToast(`🔥 ${above && !above.you ? above.name : 'Someone'} just passed you. You’re #${rank} now.`)
    }
    lastRank.current = rank
  }, [])

  useEffect(() => {
    let active = true
    request<StreakHome>('/api/streak')
      .then((h) => { if (!active) return; setHome(h); setSkew(h.event.serverNow - Date.now()); if (h.run) setRun(h.run) })
      .catch((e) => { if (active) setError(responseMessage(e)) })
    const board = window.setTimeout(() => {
      void loadBoard()
      if (new URLSearchParams(window.location.search).get('view') === 'leaderboard') setPanel('board')
    }, 0)
    const player = audio
    return () => { active = false; window.clearTimeout(board); player.current?.stop() }
  }, [loadBoard])

  // One clock for countdowns and the question timer.
  useEffect(() => { const id = window.setInterval(() => setNow(Date.now()), 100); return () => window.clearInterval(id) }, [])

  // Between runs: keep the leaderboard and Golden Hour fresh. Never during a question.
  useEffect(() => {
    if (playing) return
    const id = window.setInterval(() => {
      if (document.visibilityState !== 'visible') return
      void loadBoard()
      void loadHome().catch(() => undefined)
    }, 10_000)
    return () => window.clearInterval(id)
  }, [playing, loadBoard, loadHome])

  useEffect(() => { if (!toast) return; const t = window.setTimeout(() => setToast(null), 4500); return () => window.clearTimeout(t) }, [toast])

  // The moment the countdown hits zero, open the doors.
  const serverNow = now + skew
  const startsIn = home?.event.startAt ? home.event.startAt - serverNow : null
  const opening = home?.event.phase === 'soon' && startsIn !== null && startsIn <= 0
  useEffect(() => {
    if (!opening) return
    const t = window.setTimeout(() => void loadHome().then(() => loadBoard()).catch(() => undefined), 300)
    return () => window.clearTimeout(t)
  }, [opening, loadHome, loadBoard])

  // ---- sound ----
  const golden = home?.event.golden.live && home.event.golden.endsAt !== null && home.event.golden.endsAt > serverNow
  const ensureAudio = () => {
    if (!audio.current) audio.current = new StreakAudio()
    audio.current.setMuted(muted)
    audio.current.start()
    setSound(true)
  }
  const toggleSound = () => {
    if (!sound) { ensureAudio(); if (muted) { setMuted(false); audio.current?.setMuted(false); try { localStorage.removeItem(MUTE_KEY) } catch {} } return }
    const next = !muted
    setMuted(next)
    audio.current?.setMuted(next)
    try { if (next) localStorage.setItem(MUTE_KEY, '1'); else localStorage.removeItem(MUTE_KEY) } catch { /* private mode */ }
  }
  const streakNow = run?.streak ?? 0
  useEffect(() => {
    audio.current?.setMood(!playing ? 'lobby' : golden ? 'golden' : streakNow >= 10 ? 'fire' : streakNow >= 5 ? 'combo' : 'play', streakNow)
  }, [playing, golden, streakNow, sound])

  // ---- the run ----
  const q = playing ? run!.question! : null
  const left = q ? Math.max(0, q.deadline - serverNow) : 0

  // Last three seconds tick.
  useEffect(() => {
    if (!q) { lastTick.current = null; return }
    const sec = Math.ceil(left / 1000)
    if (left > 0 && sec <= 3 && lastTick.current !== sec) { lastTick.current = sec; audio.current?.tick() }
  }, [q, left])

  const finishRun = useCallback((r: StreakRunView, wasBest: boolean) => {
    setRun(r)
    if (wasBest) audio.current?.best(); else audio.current?.over()
    void loadHome().catch(() => undefined)
    void loadBoard()
  }, [loadHome, loadBoard])

  const settle = useCallback((res: { result: Result | null; run: StreakRunView }, choice: number | null, best: boolean) => {
    const { result, run: next } = res
    if (result?.correct) {
      const before = multiplier(next.streak - 1)
      audio.current?.correct(next.streak)
      if (multiplier(next.streak) > before) { audio.current?.combo(); setToast(`🔥 ${next.streak} in a row! Points ×${multiplier(next.streak)}`) }
      setFloat({ key: Date.now(), points: result.points, gd: result.gd, streak: next.streak, golden: result.golden })
      if (result.gdNote && !capNoted.current) {
        capNoted.current = true
        setToast(result.gdNote === 'daily_cap' ? 'You’ve earned today’s G$ limit. Points still count for the prize!' : 'The G$ pool for answers is used up. Points still count for the prize!')
      }
      setGlow((g) => g + 1)
    }
    if (next.question) setSkew(next.question.serverNow - Date.now())
    if (next.finished) {
      if (result && !result.correct) {
        audio.current?.wrong()
        setShake((s) => s + 1)
        // Show the right answer for a moment before the results.
        setReveal({ run: run!, choice, correctChoice: result.correctChoice })
        window.setTimeout(() => { setReveal(null); finishRun(next, best) }, 1500)
        return
      }
      finishRun(next, best)
      return
    }
    setRun(next)
  }, [run, finishRun])

  const begin = async (details: { campus?: string; name?: string } = {}) => {
    if (lock.current) return
    ensureAudio()
    lock.current = true; setBusy(true); setError(null)
    try {
      const r = await request<StreakRunView>('/api/streak/start', details)
      if (details.campus) void loadHome().catch(() => undefined)
      setBestThisRun(false); setReveal(null); setFloat(null)
      if (r.question) setSkew(r.question.serverNow - Date.now())
      setRun(r)
      audio.current?.go()
    } catch (e) {
      setError(responseMessage(e))
      if (e instanceof ApiError && ['needs_flowstate', 'no_runs', 'streak_closed', 'streak_soon', 'needs_campus'].includes(e.code ?? '')) void loadHome().catch(() => undefined)
    } finally { lock.current = false; setBusy(false) }
  }

  const choose = useCallback(async (choice: number) => {
    if (lock.current || !run || !q) return
    lock.current = true; setBusy(true); setPicked(choice); setError(null)
    try {
      const res = await request<{ result: Result | null; run: StreakRunView }>('/api/streak/answer', { runId: run.runId, index: q.index, choice })
      const best = bestThisRun || Boolean(res.result?.newBest)
      if (res.result?.newBest) setBestThisRun(true)
      settle(res, choice, best)
    } catch (e) { setError(responseMessage(e)) }
    finally { lock.current = false; setBusy(false); setPicked(null) }
  }, [run, q, bestThisRun, settle])

  // Out of time: tell the server. If this phone's clock ran ahead, the server says "not yet"; ask again.
  useEffect(() => {
    if (!q || left > 0 || !run) return
    let stop = false
    const expire = async (attempt: number) => {
      if (stop || lock.current) { if (!stop && attempt < 20) window.setTimeout(() => void expire(attempt + 1), 300); return }
      lock.current = true
      try {
        const res = await request<{ result: Result | null; run: StreakRunView }>('/api/streak/answer', { runId: run.runId, index: q.index, timeout: true })
        if (res.result || res.run.finished || res.run.question?.index !== q.index) {
          if (res.result) { audio.current?.wrong(); setShake((s) => s + 1); setReveal({ run, choice: null, correctChoice: res.result.correctChoice }); window.setTimeout(() => { setReveal(null); finishRun(res.run, bestThisRun) }, 1500) }
          else if (res.run.finished) finishRun(res.run, bestThisRun)
          else setRun(res.run)
        } else if (!stop && attempt < 20) window.setTimeout(() => void expire(attempt + 1), 400)
      } catch (e) { setError(responseMessage(e)) }
      finally { lock.current = false }
    }
    void expire(0)
    return () => { stop = true }
  }, [q, left, run, bestThisRun, finishRun])

  // Desktop: 1/2 or ←/→.
  useEffect(() => {
    if (!q) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === '1' || e.key === 'ArrowLeft' || e.key.toLowerCase() === 'a') void choose(0)
      if (e.key === '2' || e.key === 'ArrowRight' || e.key.toLowerCase() === 'b') void choose(1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [q, choose])

  // ---- screens ----
  if (!home) {
    return <Shell sound={sound} muted={muted} onSound={toggleSound}><div className="app-card p-6"><p role="status" className="text-sm font-semibold text-ink/55">{error ?? 'Loading Jara Streak…'}</p></div></Shell>
  }
  const { event } = home
  const runsLeft = home.runs?.left ?? 0
  const canPlay = event.phase === 'open' && home.connected && !home.playedElsewhere && home.supported

  return (
    <Shell sound={sound} muted={muted} onSound={toggleSound}>
      {toast && <div role="status" className="streak-rise fixed top-4 left-1/2 z-50 w-[min(92vw,420px)] -translate-x-1/2 rounded-2xl bg-ink px-4 py-3 text-center text-sm font-bold text-cream shadow-xl">{toast}</div>}

      {reveal || (playing && q) ? (
        <div className="mx-auto w-full max-w-2xl">
          {reveal
            ? <PlayCard run={reveal.run} left={0} busy picked={reveal.choice} reveal={reveal} golden={false} float={null} shake={shake} glow={glow} onChoose={() => undefined} />
            : <PlayCard run={run!} left={left} busy={busy} picked={picked} reveal={null} golden={Boolean(golden)} float={float} shake={shake} glow={glow} onChoose={(c) => void choose(c)} />}
        </div>
      ) : (
        <div className="mx-auto grid w-full max-w-4xl gap-5">
          {run?.finished && event.phase !== 'off' && (
            <GameOver run={run} best={bestThisRun} home={home} board={board} busy={busy} serverNow={serverNow} onAgain={() => void begin()} />
          )}

          <Hero home={home} board={board} onOpenBoard={() => setPanel('board')} serverNow={serverNow} golden={Boolean(golden)} busy={busy} canPlay={canPlay} runsLeft={runsLeft} showPlay={!run?.finished}
            onPlay={(details) => void begin(details)} onJoined={(h) => setHome(h)} onError={setError} />

          {error && <p role="alert" className="rounded-xl bg-[#fde8e2] p-3 text-sm font-semibold text-[#8a2a12]">{error}</p>}

          {event.phase === 'closed' && home.prize && <ClaimCard home={home} onClaimed={(h) => { setHome(h); audio.current?.best() }} onError={setError} />}

          <Setup home={home} />

          {event.phase !== 'off' && (
            <nav aria-label="Jara Streak" className="flex flex-wrap items-center justify-center gap-2">
              <button type="button" onClick={() => setPanel('how')} className="app-button-secondary text-sm"><Icon name="sun" className="h-4 w-4" /> How it works</button>
              <button type="button" onClick={() => setPanel('board')} className="app-button-secondary text-sm">
                <Icon name="chart" className="h-4 w-4" /> Leaderboard{board?.you?.rank ? <span className="font-semibold text-ink/50">· you’re #{board.you.rank}</span> : null}
              </button>
              {event.phase !== 'closed' && home.connected && !home.playedElsewhere && home.inviteLink && (
                <button type="button" onClick={() => setPanel('invite')} className="app-button-secondary text-sm"><Icon name="plus" className="h-4 w-4" /> Invite friends</button>
              )}
            </nav>
          )}
        </div>
      )}

      {panel === 'board' && (
        <Sheet title="Leaderboard" onClose={closePanel}>
          <LeaderboardBody
            playLabel={canPlay && home.campus && runsLeft > 0 ? 'Play Jara Streak' : 'Back to the game'}
            onPlay={() => { closePanel(); if (canPlay && home.campus && runsLeft > 0) void begin() }} />
        </Sheet>
      )}
      {panel === 'how' && <Sheet title="How Jara Streak works" onClose={closePanel}><Rules home={home} /></Sheet>}
      {panel === 'invite' && <Sheet title="Invite friends, get more runs" onClose={closePanel}><InviteBody home={home} /></Sheet>}
    </Shell>
  )
}

// ---- pieces ----

function Shell({ children, sound = false, muted = false, onSound, title = 'Jara Streak' }: { children: React.ReactNode; sound?: boolean; muted?: boolean; onSound?: () => void; title?: string }) {
  const on = sound && !muted
  return (
    <div className="jara-app min-h-dvh text-ink">
      <header className="flex min-h-20 items-center justify-between gap-3 border-b border-forest/10 bg-white px-5 py-4 sm:px-10">
        <Link href="/app" className="text-xl font-black tracking-tight">jara<span className="text-mandarin">.</span> <span className="ml-2 text-sm font-medium text-forest/70">{title}</span></Link>
        <div className="flex items-center gap-2">
          {onSound && <button type="button" onClick={onSound} aria-pressed={on} aria-label={on ? 'Turn music off' : 'Turn music on'} className="app-button-secondary text-xs">
            <span aria-hidden>{on ? '🔊' : '🔇'}</span> <span className="hidden sm:inline">{on ? 'Music on' : 'Music off'}</span>
          </button>}
          {title === 'Leaderboard' ? <Link href="/app/streak" className="app-button-secondary text-xs">Back to the game</Link> : <Link href="/app" className="app-button-secondary text-xs">Back to Jara</Link>}
        </div>
      </header>
      <main className="mx-auto w-full max-w-6xl px-4 py-6 sm:px-8 sm:py-8">{children}</main>
    </div>
  )
}

function Countdown({ ms }: { ms: number }) {
  const p = parts(ms)
  const cell = (value: number, label: string) => (
    <div className="border-r border-cream/10 px-4 py-3 text-center last:border-r-0 sm:px-5">
      <p className="text-[30px] leading-none font-semibold tracking-[-0.04em] tabular-nums sm:text-[34px]">{String(value).padStart(2, '0')}</p>
      <p className="mt-1.5 text-[10px] font-bold tracking-[0.14em] text-cream/45 uppercase">{label}</p>
    </div>
  )
  return (
    <div className="mt-6 inline-grid grid-cols-4 overflow-hidden rounded-2xl bg-forest-deep/40 ring-1 ring-cream/10" aria-label={`Starts in ${p.d} days ${p.h} hours ${p.m} minutes`}>
      {cell(p.d, 'Days')}{cell(p.h, 'Hours')}{cell(p.m, 'Mins')}{cell(p.s, 'Secs')}
    </div>
  )
}

const PLACE = ['1st', '2nd', '3rd']
const MEDAL_TONE = ['bg-crest text-ink', 'bg-[#d6dbd7] text-ink', 'bg-[#e2a774] text-ink']

/** A small medal coin for a rank: gold, silver, bronze, then a quiet number. */
function RankBadge({ rank, onDark = false }: { rank: number; onDark?: boolean }) {
  const tone = MEDAL_TONE[rank - 1] ?? (onDark ? 'bg-cream/10 text-cream/70' : 'bg-ink/5 text-ink/55')
  return <span className={`grid h-7 w-7 shrink-0 place-items-center rounded-full text-xs font-bold tabular-nums ${tone}`}>{rank}</span>
}

function Hero({ home, board, serverNow, golden, busy, canPlay, runsLeft, showPlay, onPlay, onJoined, onError, onOpenBoard }: {
  home: StreakHome; board: StreakBoard | null; serverNow: number; golden: boolean; busy: boolean; canPlay: boolean; runsLeft: number; showPlay: boolean; onOpenBoard: () => void
  onPlay: (details?: { campus?: string; name?: string }) => void; onJoined: (h: StreakHome) => void; onError: (e: string | null) => void
}) {
  const { event } = home
  if (event.phase === 'off') {
    return (
      <section className="app-card p-6 sm:p-8">
        <h1 className="text-3xl font-semibold tracking-[-0.04em]">Jara Streak</h1>
        <p className="mt-2 text-ink/60">The campus bounty isn’t open yet. Watch Jara’s socials for the date.</p>
      </section>
    )
  }
  const tease = event.golden.startsAt && !event.golden.live ? event.golden.startsAt - serverNow : null
  const leaders = (event.phase === 'open' || event.phase === 'closed') && board ? board.top : null
  const refill = event.runWindowMinutes === 60 ? 'every hour' : event.runWindowMinutes % 60 === 0 ? `every ${event.runWindowMinutes / 60} hours` : `every ${event.runWindowMinutes} min`
  const stats: [string, string][] = [
    ['Per correct answer', event.perCorrectGd > 0 ? `G$ ${num(event.perCorrectGd)}` : 'Points only'],
    ['Runs', `${event.runsPerWindow} ${refill}`],
    ['Your best', home.best && home.best.score > 0 ? `${num(home.best.score)} pts · ${home.best.streak} in a row` : 'No runs yet'],
    [home.earnedGd > 0 ? 'G$ earned' : 'Your school', home.earnedGd > 0 ? `G$ ${num(home.earnedGd)}` : home.campus ?? 'Not set yet'],
  ]
  return (
    <section className="streak-rings relative overflow-hidden rounded-[22px] bg-forest text-cream">
      {golden && event.golden.endsAt && (
        <div className="relative z-10 flex items-center justify-between gap-3 bg-mandarin px-6 py-2.5 text-sm font-semibold text-white sm:px-8">
          <span className="flex items-center gap-2"><Icon name="bolt" className="h-4 w-4" /> Golden Hour: every point counts double</span>
          <span className="tabular-nums">{shortLeft(event.golden.endsAt - serverNow)} left</span>
        </div>
      )}
      {!golden && tease !== null && tease > 0 && (
        <div className="relative z-10 flex items-center gap-2 border-b border-cream/10 px-6 py-2.5 text-sm font-semibold text-crest sm:px-8">
          <Icon name="bolt" className="h-4 w-4" /> Golden Hour starts in {shortLeft(tease)}. Double points.
        </div>
      )}

      <div className="relative z-10 grid gap-8 p-6 sm:p-8 lg:grid-cols-[minmax(0,1fr)_340px] lg:gap-12">
        <div className="min-w-0">
          <p className="flex items-center gap-2 text-[11px] font-bold tracking-[0.14em] text-crest uppercase">
            {event.phase === 'open' && <span className="streak-live h-2 w-2 rounded-full bg-mandarin" />}
            {event.phase === 'open' ? `Live · ends in ${shortLeft((event.endAt ?? 0) - serverNow)}`
              : event.phase === 'soon' ? `Campus bounty · starts ${event.startAt ? when(event.startAt) : 'soon'}`
              : 'Campus bounty · ended'}
          </p>
          <h1 className="mt-3 flex items-center gap-3 text-[40px] leading-none font-semibold tracking-[-0.05em] sm:text-[54px]">
            Jara Streak
            <span aria-hidden className="grid h-11 w-11 place-items-center rounded-2xl bg-mandarin sm:h-12 sm:w-12"><Icon name="flame" className="h-6 w-6 text-white" /></span>
          </h1>
          <p className="mt-4 max-w-md text-[15px] leading-relaxed text-cream/65">
            Two answers, one is right. Answer fast, build your streak and climb the campus leaderboard.{event.perCorrectGd > 0 ? ` Every correct answer earns G$ ${num(event.perCorrectGd)}.` : ''}
          </p>

          {event.phase === 'soon' && event.startAt && <Countdown ms={event.startAt - serverNow} />}

          {event.phase !== 'closed' && home.connected && !home.playedElsewhere && home.supported && !home.campus && (
            <div className="max-w-md">
              <JoinForm home={home} busy={busy} onJoin={async (details) => {
                if (event.phase === 'open') { onPlay(details); return }
                onError(null)
                try { onJoined(await request<StreakHome>('/api/streak/campus', details)) } catch (e) { onError(responseMessage(e)) }
              }} />
            </div>
          )}

          {event.phase === 'open' && canPlay && showPlay && home.campus && (
            <div className="mt-7 max-w-md">
              <button onClick={() => onPlay()} disabled={busy || runsLeft <= 0} className="app-button min-h-14 w-full justify-center bg-mandarin px-8 text-base text-white hover:bg-mandarin-deep disabled:opacity-60 sm:w-auto">
                {busy ? 'Starting…' : runsLeft > 0 ? (home.best?.runs ? 'Play again' : 'Start playing') : (home.runs?.nextAt ? `Next run in ${Math.max(1, Math.ceil((home.runs.nextAt - serverNow) / 60_000))} min` : 'Out of runs for now')}
                {!busy && runsLeft > 0 && <Icon name="arrow" className="h-4 w-4" />}
              </button>
              <RunDots home={home} serverNow={serverNow} />
            </div>
          )}
          {event.phase === 'closed' && <p className="mt-6 max-w-md text-sm text-cream/70">Thanks for playing. Open the leaderboard for the final standings. Winners claim their prize here.</p>}
        </div>

        {leaders ? (
          <div className="rounded-2xl bg-forest-deep/40 p-5 ring-1 ring-cream/10 sm:p-6 lg:self-start">
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs font-semibold text-cream/55">{event.phase === 'closed' ? 'Winners · final standings' : 'Top 3 right now'}</p>
              {event.phase === 'open' && <span className="flex items-center gap-1.5 text-[11px] font-bold tracking-[0.12em] text-cream/70 uppercase"><span className="streak-live h-1.5 w-1.5 rounded-full bg-[#5fd18b]" />Live</span>}
            </div>
            <p className="mt-1 text-sm text-cream/60">Prize pool <span className="font-semibold text-cream tabular-nums">G$ {num(event.prizePoolGd)}</span></p>
            <ol className="mt-4 divide-y divide-cream/10 border-t border-cream/10">
              {Array.from({ length: Math.min(event.winners, 3) }, (_, i) => {
                const p = leaders[i]
                const won = event.phase === 'closed' && p ? board?.prizes.find((x) => x.rank === p.rank) : undefined
                if (!p) {
                  return (
                    <li key={`open-${i}`} className="flex items-center gap-3 py-3 text-sm text-cream/40">
                      <RankBadge rank={i + 1} onDark /> {event.phase === 'closed' ? 'No winner' : 'Open spot. Take it.'}
                    </li>
                  )
                }
                return (
                  <li key={`${p.wallet}-${p.rank}`} className="streak-rise flex items-center gap-3 py-3">
                    <RankBadge rank={p.rank} onDark />
                    <span className="min-w-0 flex-1">
                      <span className="flex min-w-0 items-center gap-2">
                        <span className="truncate text-sm font-semibold">{p.name}{p.you ? ' (you)' : ''}</span>
                        {event.phase === 'open' && p.live && <span className="streak-live h-1.5 w-1.5 shrink-0 rounded-full bg-[#5fd18b]" title="Playing now" />}
                      </span>
                      <span className="block truncate text-[11px] text-cream/50">{p.campus ?? p.wallet} · 🔥 {p.streak}{won ? ` · ${num(p.score)} pts` : ''}</span>
                    </span>
                    {won ? (
                      <span className="shrink-0 text-right">
                        <span className="block text-sm font-semibold text-crest tabular-nums">G$ {num(won.amountGd)}</span>
                        <span className={`mt-0.5 flex items-center justify-end gap-1 text-[10px] font-bold tracking-wide uppercase ${won.claimed ? 'text-[#5fd18b]' : 'text-cream/45'}`}>
                          {won.claimed && <Icon name="check" className="h-3 w-3" strokeWidth={3} />}{won.claimed ? 'Claimed' : 'To claim'}
                        </span>
                      </span>
                    ) : (
                      <span className="shrink-0 text-sm font-semibold tabular-nums">{num(p.score)} <span className="text-xs font-medium text-cream/45">pts</span></span>
                    )}
                  </li>
                )
              })}
            </ol>
            <button type="button" onClick={onOpenBoard} className="mt-4 flex w-full items-center justify-center gap-1.5 rounded-xl bg-cream/10 px-4 py-2.5 text-sm font-semibold text-cream ring-1 ring-cream/15 transition hover:bg-cream/15">
              See full leaderboard <Icon name="arrow" className="h-4 w-4" />
            </button>
          </div>
        ) : (
          <div className="rounded-2xl bg-forest-deep/40 p-5 ring-1 ring-cream/10 sm:p-6 lg:self-start">
            <p className="text-xs font-semibold text-cream/55">Prize pool</p>
            <p className="mt-2 text-[42px] leading-none font-semibold tracking-[-0.05em] tabular-nums"><span className="mr-1.5 text-[22px] font-medium tracking-normal text-crest">G$</span>{num(event.prizePoolGd)}</p>
            <p className="mt-2 text-xs leading-relaxed text-cream/50">Shared by the top {event.winners}. The higher you finish, the bigger your share.</p>
            <ul className="mt-5 divide-y divide-cream/10 border-t border-cream/10">
              {event.prizesGd.slice(0, 3).map((amount, i) => (
                <li key={i} className="flex items-center justify-between gap-3 py-3">
                  <span className="flex items-center gap-3 text-sm font-semibold"><RankBadge rank={i + 1} onDark />{PLACE[i]} place</span>
                  <span className="text-sm font-semibold tabular-nums">G$ {num(amount)}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      <dl className="relative z-10 grid grid-cols-2 gap-px border-t border-cream/10 bg-cream/10 lg:grid-cols-4">
        {stats.map(([label, value]) => (
          <div key={label} className="min-w-0 bg-forest px-6 py-4 sm:px-8">
            <dt className="text-[11px] font-semibold text-cream/50">{label}</dt>
            <dd className="mt-1 truncate text-[15px] font-semibold tabular-nums">{value}</dd>
          </div>
        ))}
      </dl>
    </section>
  )
}

function RunDots({ home, serverNow }: { home: StreakHome; serverNow: number }) {
  const r = home.runs
  if (!r) return null
  const dots = Math.min(r.perWindow, 8)
  const mins = r.nextAt ? Math.max(1, Math.ceil((r.nextAt - serverNow) / 60_000)) : 0
  return (
    <div className="mt-3 flex flex-wrap items-center justify-center gap-x-3 gap-y-1 text-xs font-semibold text-cream/75">
      <span className="flex gap-1" aria-hidden>
        {Array.from({ length: dots }, (_, i) => <span key={i} className={`h-2.5 w-2.5 rounded-full ${i < Math.min(r.left, dots) ? 'bg-mandarin' : 'bg-cream/20'}`} />)}
      </span>
      <span>{r.left > 0 ? `${r.left} run${r.left === 1 ? '' : 's'} ready${r.bonus > 0 ? ` · +${r.bonus} from invites` : ''} · they refill over time` : `Next run in ${mins} min${mins === 1 ? '' : 's'}`}</span>
    </div>
  )
}

function PlayCard({ run, left, busy, picked, reveal, golden, float, shake, glow, onChoose }: {
  run: StreakRunView; left: number; busy: boolean; picked: number | null; reveal: Reveal | null; golden: boolean
  float: Float | null; shake: number; glow: number; onChoose: (choice: number) => void
}) {
  const q = run.question!
  const pct = Math.max(0, Math.min(100, (left / q.limitMs) * 100))
  const urgent = left < 2_500
  const combo = multiplier(run.streak + 1)
  const streakTone = golden ? 'text-mandarin' : run.streak >= 10 ? 'text-mandarin-deep' : run.streak >= 5 ? 'text-mandarin' : 'text-forest'
  const streakLabel = run.streak === 0 ? 'start your streak' : run.streak >= 20 ? 'unstoppable' : run.streak >= 10 ? 'on fire' : run.streak >= 5 ? 'you’re on a roll' : `${run.streak} in a row`
  return (
    <section key={`shake-${shake}`} className={`app-card relative overflow-hidden p-5 sm:p-6 ${reveal ? 'streak-shake' : ''} ${golden ? 'ring-2 ring-mandarin' : ''}`}>
      {/* The streak itself is the hero: a big flame and count, not a chip in a corner. */}
      <div className="relative min-h-[78px]">
        <div className="absolute top-0 left-0">
          <p className="text-[10px] font-bold tracking-[0.14em] text-ink/40 uppercase">Points</p>
          <p key={`glow-${glow}`} className="streak-glow -ml-1 rounded-lg px-1 text-2xl leading-none font-bold tabular-nums">{num(run.score)}</p>
          <p className="mt-1.5 text-[10px] font-bold tracking-[0.14em] text-ink/40 uppercase">G$ earned</p>
          <p className="text-sm leading-none font-bold text-forest tabular-nums">G$ {num(run.earnedGd)}</p>
        </div>
        <div className="absolute top-0 right-0 flex items-center gap-1.5">
          {golden && <span className="rounded-full bg-mandarin px-2.5 py-1 text-xs font-bold text-white">⚡ ×2</span>}
          {!golden && combo > 1 && <span className="rounded-full bg-mandarin/15 px-2.5 py-1 text-xs font-bold text-mandarin-deep">×{combo} combo</span>}
        </div>
        <div className="flex flex-col items-center pt-0.5">
          <div className="flex items-end gap-1.5">
            <span className={`text-4xl leading-none ${run.streak > 0 ? 'streak-flame' : 'opacity-40 grayscale'}`}>🔥</span>
            <span key={`streak-${run.streak}`} className={`streak-bump text-6xl leading-[0.8] font-black tabular-nums ${streakTone}`}>{run.streak}</span>
          </div>
          <p className="mt-1.5 text-[11px] font-bold tracking-[0.16em] text-ink/45 uppercase">{streakLabel}</p>
        </div>
      </div>

      <div className="mt-4 h-2.5 overflow-hidden rounded-full bg-ink/10" aria-hidden>
        <div className={`h-full rounded-full transition-[width] duration-100 ease-linear ${urgent ? 'bg-mandarin' : 'bg-forest'}`} style={{ width: `${pct}%` }} />
      </div>
      <p className={`mt-1 text-right text-xs font-bold tabular-nums ${urgent ? 'text-mandarin' : 'text-ink/50'}`} aria-live="polite">{(left / 1000).toFixed(1)}s</p>

      {float && <StreakBurst key={float.key} float={float} />}

      <p className="mt-2 text-[11px] font-bold tracking-[0.14em] text-forest/60 uppercase">{q.topic}</p>
      <h2 className="mt-1 min-h-16 text-2xl leading-snug font-bold tracking-tight">{q.prompt}</h2>

      <div className="mt-5 grid gap-3 sm:grid-cols-2">
        {q.options.map((o, i) => {
          const right = reveal && reveal.correctChoice === i
          const wrong = reveal && reveal.choice === i && reveal.correctChoice !== i
          const tone = right ? 'border-forest bg-[#e9f3e4] text-forest' : wrong ? 'border-[#c2410c] bg-[#fdebe4] text-[#8a2a12]' : picked === i ? 'border-forest/60 bg-[#f3f7ef]' : 'border-ink/12 bg-white hover:border-forest/40 hover:bg-[#f3f7ef]'
          return (
            <button key={`${q.index}-${i}`} disabled={busy || left <= 0} onClick={() => onChoose(i)}
              className={`flex min-h-20 items-center gap-3 rounded-2xl border-2 px-4 py-4 text-left text-lg font-bold transition active:scale-[0.98] disabled:cursor-default ${tone}`}>
              <span className="grid h-8 w-8 shrink-0 place-items-center rounded-full bg-forest/10 text-sm text-forest">{right ? '✓' : wrong ? '✕' : i + 1}</span>
              <span className="min-w-0">{o}</span>
            </button>
          )
        })}
      </div>
      {reveal && <p className="mt-4 text-center text-sm font-bold text-[#8a2a12]">{reveal.choice === null ? '⏰ Time’s up!' : 'Not this time!'}</p>}
    </section>
  )
}

const SPARKS = [
  { dx: '-58px', dy: '-34px', rot: '-25deg' }, { dx: '60px', dy: '-30px', rot: '25deg' }, { dx: '-34px', dy: '-70px', rot: '-10deg' },
  { dx: '36px', dy: '-72px', rot: '12deg' }, { dx: '0px', dy: '-88px', rot: '0deg' },
]

/** A correct answer: a fire burst with what it added (G$ 20, or the points once the G$ cap is reached). */
function StreakBurst({ float }: { float: Float }) {
  const hot = float.streak >= 5
  return (
    <span aria-hidden className="pointer-events-none absolute top-14 left-1/2 z-10">
      {(hot ? SPARKS : SPARKS.slice(0, 3)).map((s, i) => (
        <span key={i} className="streak-spark text-lg" style={{ '--dx': s.dx, '--dy': s.dy, '--rot': s.rot, animationDelay: `${i * 40}ms` } as React.CSSProperties}>🔥</span>
      ))}
      <span className={`streak-burst absolute left-0 grid min-w-28 justify-items-center rounded-2xl px-4 py-2 text-center shadow-lg ${float.golden ? 'bg-mandarin text-white ring-2 ring-crest' : hot ? 'bg-mandarin text-white' : 'bg-forest text-cream'}`}>
        <span className="flex items-center gap-1 text-2xl leading-none font-black"><span className="streak-flame">🔥</span>{float.gd > 0 ? `+${num(float.gd)}` : `+${num(float.points)}`}</span>
        <span className="mt-1 text-[11px] leading-none font-bold whitespace-nowrap opacity-90">{float.gd > 0 ? `G$ earned · +${num(float.points)} pts` : `points · ${float.streak} in a row`}{float.golden ? ' · ⚡×2' : ''}</span>
      </span>
    </span>
  )
}

function GameOver({ run, best, home, board, busy, serverNow, onAgain }: { run: StreakRunView; best: boolean; home: StreakHome; board: StreakBoard | null; busy: boolean; serverNow: number; onAgain: () => void }) {
  const you = board?.you
  const runsLeft = home.runs?.left ?? 0
  const title = run.ended === 'timeout' ? 'Time’s up' : run.ended === 'wrong' ? 'Run over!' : run.ended === 'cleared' ? 'You answered every question!' : run.ended === 'closed' ? 'The bounty has ended' : 'Run over'
  const share = `🔥 I just hit a ${run.streak} streak (${num(run.score)} pts) on Jara Streak! The top ${home.event.winners} share a G$ ${num(home.event.prizePoolGd)} prize pool. Beat me 👉 ${home.inviteLink ?? ''}`
  return (
    <section className="app-card streak-rise overflow-hidden">
      <div className="bg-[#f4f5ef] px-5 py-5 text-center sm:px-6">
        <p className="text-sm font-bold text-ink/60">{title}</p>
        <p className="mt-2 text-5xl leading-none font-bold tracking-tight tabular-nums">{num(run.score)}</p>
        <p className="mt-1 text-sm font-semibold text-ink/55">points for the leaderboard · 🔥 {run.streak} in a row</p>
        {run.earnedGd > 0 && <p className="mt-3 rounded-xl bg-[#e9f3e4] px-3 py-2 text-sm font-bold text-forest">You earned G$ {num(run.earnedGd)} this run. {run.paid ? 'It’s in your wallet' : 'It’s on its way to your wallet'}, ready to spend in Jara on airtime, data, electricity or Jara AI.</p>}
        {best && run.score > 0 ? <p className="mt-3 inline-block rounded-full bg-mandarin px-3 py-1 text-sm font-bold text-white">New personal best</p>
          : home.best && home.best.score > 0 && <p className="mt-3 text-sm font-semibold text-ink/60">Your best: {num(home.best.score)} pts</p>}
        {you?.rank && (
          <p className="mt-3 text-sm font-bold text-forest">
            {you.rank <= home.event.winners ? `You’re #${you.rank}, in the prize zone. Hold on to it.` : `You’re #${you.rank}${you.toPodium ? `, ${num(you.toPodium)} points from the top ${home.event.winners}` : ''}.`}
          </p>
        )}
      </div>
      <div className="grid gap-2.5 p-5 sm:px-6">
        {home.event.phase === 'open' && (
          <button onClick={onAgain} disabled={busy || runsLeft <= 0} className="app-button min-h-12 justify-center bg-mandarin text-sm text-white hover:bg-mandarin-deep disabled:opacity-60">
            {busy ? 'Starting…' : runsLeft > 0 ? `Play again · ${runsLeft} run${runsLeft === 1 ? '' : 's'} ready` : (home.runs?.nextAt ? `Next run in ${Math.max(1, Math.ceil((home.runs.nextAt - serverNow) / 60_000))} min — invite a friend for more now` : 'Out of runs — invite a friend for more')}
          </button>
        )}
        <div className="grid grid-cols-2 gap-2">
          <a href={`https://wa.me/?text=${encodeURIComponent(share)}`} target="_blank" rel="noreferrer" className="app-button-secondary justify-center text-sm">Share on WhatsApp</a>
          <ShareButton text={share} />
        </div>
      </div>
    </section>
  )
}

function ShareButton({ text, label = 'Share' }: { text: string; label?: string }) {
  const [done, setDone] = useState(false)
  const share = async () => {
    const nav = navigator as Navigator & { share?: (d: { text: string }) => Promise<void> }
    if (nav.share) { await nav.share({ text }).catch(() => undefined); return }
    await navigator.clipboard?.writeText(text).then(() => setDone(true), () => undefined)
  }
  return <button type="button" onClick={() => void share()} className="app-button-secondary justify-center text-sm">{done ? 'Copied!' : label}</button>
}

/** After the bounty ends, a winner claims their share of the prize pool. */
function ClaimCard({ home, onClaimed, onError }: { home: StreakHome; onClaimed: (h: StreakHome) => void; onError: (e: string | null) => void }) {
  const [busy, setBusy] = useState(false)
  const prize = home.prize!
  const claim = async () => {
    setBusy(true); onError(null)
    try { onClaimed(await request<StreakHome>('/api/streak/claim', {})) }
    catch (e) { onError(responseMessage(e)) }
    finally { setBusy(false) }
  }
  return (
    <section className="streak-rings streak-rise relative overflow-hidden rounded-[22px] bg-forest p-5 text-cream sm:p-6"><div className="relative z-10">
      <span className={`grid h-12 w-12 place-items-center rounded-full text-lg font-bold tabular-nums ${MEDAL_TONE[prize.rank - 1] ?? 'bg-cream/10 text-cream'}`}>{prize.rank}</span>
      <h2 className="mt-2 text-2xl font-bold tracking-tight">You finished #{prize.rank}{home.name ? `, ${home.name.split(' ')[0]}` : ''}!</h2>
      {prize.claimed ? (
        <p className="mt-1 font-semibold">✓ Claimed. <b>G$ {num(prize.amountGd)}</b> is in your wallet. Spend it in Jara on airtime, data, electricity or Jara AI.</p>
      ) : (
        <>
          <p className="mt-1 font-semibold">Your share of the prize pool: <b>G$ {num(prize.amountGd)}</b>. Claim it, then spend it in Jara on airtime, data, electricity or Jara AI.</p>
          <button onClick={() => void claim()} disabled={busy} className="app-button mt-4 min-h-14 w-full justify-center bg-mandarin text-base text-white hover:bg-mandarin-deep disabled:opacity-60">
            {busy ? 'Sending to your wallet…' : `Claim G$ ${num(prize.amountGd)}`}
          </button>
        </>
      )}
      </div>
    </section>
  )
}

function Setup({ home }: { home: StreakHome }) {
  const { event } = home
  if (event.phase === 'closed' || event.phase === 'off') return null
  if (!home.signedIn || !home.connected) {
    return (
      <section className="app-card p-5 sm:p-6">
        <h2 className="text-lg font-semibold tracking-tight">{home.signedIn ? 'Verify your GoodDollar wallet to play' : 'Join Jara to play'}</h2>
        <p className="mt-1 text-sm text-ink/60">One player per real person: you play with your verified GoodDollar wallet, and that’s where your G$ and any prize land.</p>
        <Link href="/app" className="app-button mt-4 w-full justify-center bg-forest text-cream hover:bg-forest-soft min-h-12 text-sm">{home.signedIn ? 'Finish setting up →' : 'Get started on Jara →'}</Link>
      </section>
    )
  }
  if (home.playedElsewhere) {
    return <section className="app-card p-5 sm:p-6"><p className="font-bold">This GoodDollar identity already plays from another Jara account. Open Jara there to play.</p></section>
  }
  if (!home.supported) {
    return (
      <section className="app-card p-5 sm:p-6">
        <h2 className="text-lg font-semibold tracking-tight">One step: vote for Jara on Flowstate</h2>
        <p className="mt-1 text-sm text-ink/60">Give Jara at least one of your GoodBuilders votes. It’s free: Jara covers the network fee. Then come back and play.</p>
        <Link href="/app#vote" className="app-button mt-4 w-full justify-center bg-forest text-cream hover:bg-forest-soft min-h-12 text-sm">Vote for Jara →</Link>
      </section>
    )
  }
  return null
}

/**
 * Pick a school inside the card: search, tap one from the list below, or, if it isn't listed, use
 * exactly what you typed. Everything stays in this section (no browser pop-up).
 */
function SchoolPicker({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  const [query, setQuery] = useState('')
  const q = query.trim().toLowerCase()
  const matches = q ? CAMPUSES.filter((c) => c.toLowerCase().includes(q)) : CAMPUSES
  const exact = CAMPUSES.some((c) => c.toLowerCase() === q)
  const row = 'flex min-h-11 w-full items-center justify-between gap-3 px-3 text-left text-sm font-semibold transition'
  if (value) {
    return (
      <div className="grid gap-1 text-xs font-bold text-cream/75">Your school
        <div className="flex min-h-12 items-center justify-between gap-3 rounded-xl bg-white px-3 text-ink">
          <span className="flex min-w-0 items-center gap-2 font-semibold"><Icon name="check" className="h-4 w-4 shrink-0 text-forest" strokeWidth={3} /><span className="truncate">{value}</span></span>
          <button type="button" onClick={() => { onChange(''); setQuery('') }} className="shrink-0 text-xs font-bold text-forest underline">Change</button>
        </div>
      </div>
    )
  }
  return (
    <div className="grid gap-1 text-xs font-bold text-cream/75">
      <label htmlFor="streak-school">Your school (you can only pick once)</label>
      <div className="overflow-hidden rounded-xl bg-white text-ink">
        <input id="streak-school" value={query} onChange={(e) => setQuery(e.target.value)} maxLength={40} autoComplete="off" placeholder="Search your school…"
          className="min-h-12 w-full border-b border-ink/10 bg-transparent px-3 font-semibold outline-none placeholder:text-ink/40" />
        <ul className="max-h-52 overflow-y-auto overscroll-contain py-1" role="listbox" aria-label="Schools">
          {matches.map((c) => (
            <li key={c}><button type="button" role="option" aria-selected={false} onClick={() => onChange(c)} className={`${row} hover:bg-[#f3f7ef]`}>{c}<Icon name="arrow" className="h-3.5 w-3.5 text-ink/25" /></button></li>
          ))}
          {q.length >= 2 && !exact && (
            <li className="border-t border-ink/10"><button type="button" onClick={() => onChange(query.replace(/\s+/g, ' ').trim())} className={`${row} text-forest hover:bg-[#f3f7ef]`}>
              <span className="min-w-0 truncate">Not listed? Use “{query.trim()}”</span><Icon name="plus" className="h-4 w-4 shrink-0" />
            </button></li>
          )}
          {matches.length === 0 && q.length < 2 && <li className="px-3 py-3 text-sm font-medium text-ink/50">Type at least 2 letters.</li>}
        </ul>
      </div>
      <p className="font-medium text-cream/55">Can’t find it? Type your school’s name and tap “Use”.</p>
    </div>
  )
}

/** First time only: the school (for the campus leaderboard) and, if the account has none, a name. */
function JoinForm({ home, busy, onJoin }: { home: StreakHome; busy: boolean; onJoin: (details: { campus: string; name?: string }) => Promise<void> | void }) {
  const [campus, setCampus] = useState('')
  const [name, setName] = useState('')
  const [saving, setSaving] = useState(false)
  const needsName = !home.name
  const ready = campus.trim().length >= 2 && (!needsName || name.trim().length >= 2)
  const field = 'min-h-12 w-full rounded-xl border-0 bg-white px-3 font-semibold text-ink'
  return (
    <form className="mt-5 grid gap-2.5 rounded-2xl bg-cream/10 p-4 ring-1 ring-cream/15" onSubmit={async (e) => {
      e.preventDefault()
      if (!ready) return
      setSaving(true)
      try { await onJoin({ campus, ...(needsName ? { name: name.trim() } : {}) }) } finally { setSaving(false) }
    }}>
      <p className="font-bold">{home.event.phase === 'open' ? 'Before your first run' : 'Save your spot'}</p>
      {needsName && (
        <label className="grid gap-1 text-xs font-bold text-cream/75">Your name on the leaderboard
          <input value={name} onChange={(e) => setName(e.target.value)} maxLength={30} autoComplete="given-name" placeholder="e.g. Tolu A." className={field} />
        </label>
      )}
      <SchoolPicker value={campus} onChange={setCampus} />
      <button type="submit" disabled={!ready || saving || busy} className="app-button mt-1 min-h-14 w-full justify-center bg-mandarin text-base text-white hover:bg-mandarin-deep disabled:opacity-60">
        {saving || busy ? 'One moment…' : home.event.phase === 'open' ? 'Let’s play 🔥' : 'Save my spot'}
      </button>
    </form>
  )
}

function PlayerRow({ p, board }: { p: StreakBoard['top'][number]; board: StreakBoard }) {
  const prize = p.rank <= board.winners
  return (
    <li className={`flex items-center gap-3 rounded-xl px-3 py-2.5 ${p.you ? 'bg-[#eef4e8]' : ''}`}>
      <RankBadge rank={p.rank} />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate text-sm font-semibold">{p.name}{p.you ? ' (you)' : ''}</span>
          {p.live && <span className="flex shrink-0 items-center gap-1 text-[10px] font-bold tracking-wide text-forest uppercase"><span className="streak-live h-1.5 w-1.5 rounded-full bg-[#2f9e5a]" />Playing</span>}
        </span>
        <span className="mt-0.5 flex min-w-0 items-center gap-2 text-[11px] font-medium text-ink/45">
          <span className="truncate">{p.campus ?? p.wallet}</span>
          <span className="shrink-0 font-semibold text-mandarin-deep" title={`Best streak: ${p.streak} in a row`}>🔥 {p.streak}</span>
        </span>
      </span>
      <span className="shrink-0 text-right">
        <span className="block text-sm font-semibold tabular-nums">{num(p.score)} <span className="text-xs font-medium text-ink/45">pts</span></span>
        {prize && <span className="block text-[11px] font-semibold text-ink/45 tabular-nums">wins G$ {num(board.prizesGd[p.rank - 1] ?? 0)}</span>}
      </span>
    </li>
  )
}

/** The leaderboard pop-up: every player (scrolls, however many) and every campus, live. */
function LeaderboardBody({ playLabel, onPlay }: { playLabel: string; onPlay: () => void }) {
  const [board, setBoard] = useState<StreakBoard | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [tab, setTab] = useState<'players' | 'campuses'>('players')
  useEffect(() => {
    const get = () => request<StreakBoard>('/api/streak/leaderboard?limit=200').then((b) => { setBoard(b); setError(null) }, (e) => setError(responseMessage(e)))
    const first = window.setTimeout(() => void get(), 0)
    const id = window.setInterval(() => { if (document.visibilityState === 'visible') void get() }, 10_000)
    return () => { window.clearTimeout(first); window.clearInterval(id) }
  }, [])
  const tabClass = (t: string) => `flex-1 rounded-full px-4 py-2 text-sm font-semibold transition ${tab === t ? 'bg-white text-ink shadow-sm' : 'text-ink/55 hover:text-ink'}`
  if (!board) return <p role="status" className="py-10 text-center text-sm text-ink/55">{error ?? 'Loading the leaderboard…'}</p>
  return (
    <div>
      <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-ink/55">
        {board.phase === 'open' && <span className="flex items-center gap-1.5 font-semibold text-forest"><span className="streak-live h-2 w-2 rounded-full bg-[#2f9e5a]" />Live</span>}
        {board.phase === 'closed' && <span className="font-semibold text-forest">Final standings</span>}
        <span>{num(board.players)} player{board.players === 1 ? '' : 's'}</span>
        {board.phase === 'open' && board.playingNow > 0 && <span>· {board.playingNow} playing now</span>}
      </p>

      <div className="sticky top-0 z-10 -mx-1 mt-4 bg-white px-1 py-2">
        <div className="flex gap-1 rounded-full bg-[#f1f3ee] p-1" role="tablist">
          <button role="tab" aria-selected={tab === 'players'} className={tabClass('players')} onClick={() => setTab('players')}>Players</button>
          <button role="tab" aria-selected={tab === 'campuses'} className={tabClass('campuses')} onClick={() => setTab('campuses')}>Campuses</button>
        </div>
      </div>

      {tab === 'players' ? (
        board.top.length === 0 ? <p className="py-10 text-center text-sm text-ink/50">No scores yet. The first run takes #1.</p> : (
          <ol className="mt-1 grid gap-0.5">{board.top.map((p) => <PlayerRow key={p.rank} p={p} board={board} />)}</ol>
        )
      ) : (
        board.campuses.length === 0 ? <p className="py-10 text-center text-sm text-ink/50">No campus on the board yet.</p> : (
          <ol className="mt-1 grid gap-0.5">
            {board.campuses.map((c) => (
              <li key={c.campus} className="flex items-center gap-3 rounded-xl px-3 py-2.5">
                <RankBadge rank={c.rank} />
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-sm font-semibold">{c.campus}</span>
                  <span className="block text-[11px] font-medium text-ink/45">{c.players} player{c.players === 1 ? '' : 's'}</span>
                </span>
                <span className="shrink-0 text-sm font-semibold tabular-nums">{num(c.score)} <span className="text-xs font-medium text-ink/45">pts</span></span>
              </li>
            ))}
          </ol>
        )
      )}

      {tab === 'players' && board.you?.rank && !board.top.some((p) => p.you) && (
        <p className="mt-3 rounded-xl bg-[#eef4e8] px-3 py-2.5 text-sm font-semibold">You’re #{board.you.rank} · {num(board.you.score)} pts{board.you.toPodium ? ` · ${num(board.you.toPodium)} to the top ${board.winners}` : ''}</p>
      )}

      <p className="mt-5 border-t border-ink/5 pt-4 text-xs leading-relaxed text-ink/50">
        {board.phase === 'closed' && board.prizes.length
          ? `Winners: ${board.prizes.map((p) => `${PLACE[p.rank - 1] ?? `#${p.rank}`} G$ ${num(p.amountGd)}`).join(' · ')}. ${board.prizes.every((p) => p.claimed) ? 'All prizes claimed.' : 'Winners: claim your prize on the game page.'}`
          : tab === 'players'
            ? `Ranked by points from each player’s best run. 🔥 is their longest streak. Points decide the ranking; G$ is earned separately (G$ for every correct answer).`
            : 'Each campus adds up its players’ best runs.'}
      </p>

      {board.phase !== 'closed' && (
        <div className="sticky bottom-0 z-10 -mx-5 mt-4 border-t border-ink/5 bg-white px-5 pt-3 pb-1 sm:-mx-7 sm:px-7">
          <button type="button" onClick={onPlay} className="app-button min-h-12 w-full justify-center bg-mandarin text-sm text-white hover:bg-mandarin-deep">{playLabel}</button>
        </div>
      )}
    </div>
  )
}

function InviteBody({ home }: { home: StreakHome }) {
  const [copied, setCopied] = useState(false)
  const r = home.runs
  if (!home.inviteLink) return null
  const text = `Jara Streak 🔥 How many can you get right in a row? The top ${home.event.winners} share a G$ ${num(home.event.prizePoolGd)} prize pool. Join with my link: ${home.inviteLink}`
  const maxed = r ? r.bonus >= r.maxFriendRuns : false
  return (
    <div>
      <p className="text-sm leading-relaxed text-ink/60">
        Every friend who joins Jara with your link and verifies gives you <b className="text-ink">+{home.event.runsPerFriend} extra runs</b> on top of your refilling runs{r ? ` (up to +${r.maxFriendRuns})` : ''}.
      </p>
      {r && r.friends > 0 && <p className="mt-3 text-sm font-semibold text-forest">✓ {r.friends} friend{r.friends === 1 ? '' : 's'} joined · +{r.bonus} extra runs at a time{maxed ? ' (max)' : ''}</p>}
      <div className="mt-4 grid grid-cols-2 gap-2">
        <a href={`https://wa.me/?text=${encodeURIComponent(text)}`} target="_blank" rel="noreferrer" className="app-button justify-center bg-forest text-cream hover:bg-forest-soft text-sm">WhatsApp</a>
        <button type="button" onClick={() => navigator.clipboard?.writeText(home.inviteLink!).then(() => setCopied(true), () => undefined)} className="app-button-secondary justify-center text-sm">{copied ? 'Link copied!' : 'Copy my link'}</button>
      </div>
    </div>
  )
}

function Rules({ home }: { home: StreakHome }) {
  const { event } = home
  const rows: [IconName, string, React.ReactNode][] = [
    ['chart', 'Points and G$ are different', <><b className="font-semibold text-ink">Points</b> decide your place on the leaderboard: each correct answer gives 100 to 150 (faster is more), multiplied by your combo and by Golden Hour. That’s why scores reach the thousands. <b className="font-semibold text-ink">G$</b> is real money{event.perCorrectGd > 0 ? `: G$ ${num(event.perCorrectGd)} for every correct answer, however many points it scored` : ''}.</>],
    ['bolt', 'Answer fast', <>Two answers, one is right. You get 7 seconds, a little less as your streak grows.</>],
    ['x', 'One miss ends the run', <>A wrong answer, or running out of time, ends it. Then go again.</>],
    ['flame', 'Build combos', <>5 in a row ×2, 10 in a row ×3, 20 in a row ×4. Faster answers score more.</>],
    ...(event.perCorrectGd > 0 ? [['coins', 'Earn G$ as you play', <>G$ {num(event.perCorrectGd)} for every correct answer, up to G$ {num(event.dailyCapGd)} a day, sent to your wallet after each run.</>] as [IconName, string, React.ReactNode]] : []),
    ['undo', 'Runs refill', <>{event.runsPerWindow} runs at a time that come back as time passes. Only your best run counts.</>],
    ['sparkle', 'Golden Hours', <>Announced windows when every point counts double. Follow Jara’s socials.</>],
    ['star', 'Win the prize pool', <>When it ends{event.endAt ? ` (${when(event.endAt - 60_000)})` : ''}, the top {event.winners} share G$ {num(event.prizePoolGd)}: {event.prizesGd.map((g, i) => <span key={i}>{i ? ', ' : ''}{PLACE[i] ?? `#${i + 1}`} G$ {num(g)}</span>)}. Winners tap Claim.</>],
    ['jar', 'Spend it in Jara', <>All the G$ you win, from answers and prizes, is for using in Jara: airtime, data, electricity or Jara AI.</>],
  ]
  return (
    <div>
      <ul className="grid gap-5">
        {rows.map(([icon, title, text]) => (
          <li key={title} className="flex gap-3.5">
            <span aria-hidden className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-[#f4f7ef] text-forest"><Icon name={icon} className="h-[18px] w-[18px]" strokeWidth={2} /></span>
            <span className="min-w-0">
              <span className="block text-sm font-semibold">{title}</span>
              <span className="mt-0.5 block text-sm leading-relaxed text-ink/60">{text}</span>
            </span>
          </li>
        ))}
      </ul>
      <p className="mt-6 flex items-center gap-1.5 border-t border-ink/5 pt-4 text-xs font-medium text-ink/50"><Icon name="check" className="h-3.5 w-3.5" strokeWidth={3} /> One player per verified person. The clock and the answers live on Jara’s server, so it’s fair for everyone.</p>
    </div>
  )
}

/** A panel over the page: slides up on phones, centred on desktop. Esc or tapping outside closes it. */
function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  const ref = useSheetDialog(onClose)
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end justify-center bg-ink/40 sm:items-center sm:p-6" onClick={onClose}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} onClick={(e) => e.stopPropagation()}
        className="streak-rise max-h-[88dvh] w-full overflow-y-auto rounded-t-3xl bg-white px-5 pt-3 pb-[max(20px,env(safe-area-inset-bottom))] text-ink shadow-2xl outline-none sm:max-w-xl sm:rounded-3xl sm:p-7">
        <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-ink/15 sm:hidden" />
        <div className="flex items-center justify-between gap-3">
          <h2 className="text-xl font-semibold tracking-tight">{title}</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="grid h-10 w-10 shrink-0 place-items-center rounded-full hover:bg-ink/5"><Icon name="x" className="h-5 w-5" /></button>
        </div>
        <div className="mt-5">{children}</div>
      </div>
    </div>,
    document.body,
  )
}
