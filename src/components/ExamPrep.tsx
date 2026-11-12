'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { useEffect, useRef, useState } from 'react'
import { clientRequest } from '@/lib/client-request'
import { readApiResponse, responseMessage } from '@/lib/api-response'
import { EXAM_OPTIONS, type ExamSession } from '@/lib/exam-paper'

type Home = { connected: boolean; balanceGd: number; priceGd: number; questionCount: number; sessions: { id: number; title: string; count: number; answered: number; submitted: boolean }[] }
const primary = 'rounded-xl bg-forest px-6 py-3 font-bold text-white disabled:opacity-40'
const secondary = 'rounded-xl border border-forest/20 bg-white px-5 py-3 font-semibold disabled:opacity-40'

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, { ...init, headers: { 'Content-Type': 'application/json', ...init?.headers } })
  return readApiResponse<T>(response)
}

export function ExamPrep({ initialRun, initialTopic }: { initialRun: number | null; initialTopic: string }) {
  const router = useRouter()
  const [home, setHome] = useState<Home | null>(null)
  const [session, setSession] = useState<ExamSession | null>(null)
  const [exam, setExam] = useState<string>('JAMB')
  const [topic, setTopic] = useState(initialTopic)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [saved, setSaved] = useState(false)
  const lock = useRef(false)
  const heading = useRef<HTMLHeadingElement>(null)

  useEffect(() => {
    let active = true
    Promise.all([request<Home>('/api/exams'), initialRun ? request<ExamSession>(`/api/exams/${initialRun}`) : Promise.resolve(null)])
      .then(([h, s]) => { if (active) {
    try {
      const draft = JSON.parse(sessionStorage.getItem('jara:exam-draft') || 'null')
      if (!initialTopic && draft && typeof draft.topic === 'string' && typeof draft.exam === 'string') { setTopic(draft.topic); setExam(draft.exam) }
    } catch { /* Draft storage is optional. */ }
      setHome(h); setSession(s); setSaved(Boolean(s))
    } })
      .catch((e) => { if (active) setError(responseMessage(e)) })
      .finally(() => { if (active) setLoading(false) })
    return () => { active = false }
  }, [initialRun, initialTopic])

  async function newPractice() {
    if (lock.current) return
    lock.current = true; setBusy(true); setError('')
    try {
      setHome(await request<Home>('/api/exams')); setSession(null)
      window.history.replaceState(null, '', '/app/exam'); window.scrollTo(0, 0)
    } catch (e) { setError(responseMessage(e)) }
    finally { lock.current = false; setBusy(false) }
  }

  async function open(id: number) {
    if (lock.current) return
    lock.current = true; setBusy(true); setError('')
    try {
      const next = await request<ExamSession>(`/api/exams/${id}`)
      setSession(next); setSaved(true)
      window.history.replaceState(null, '', `/app/exam?run=${id}`)
      window.scrollTo(0, 0)
    } catch (e) { setError(responseMessage(e)) }
    finally { lock.current = false; setBusy(false) }
  }

  async function start(event: React.FormEvent) {
    event.preventDefault()
    if (lock.current || !home) return
    lock.current = true; setBusy(true); setError('')
    const input = `${exam}: ${topic.trim()}`
    try { sessionStorage.setItem('jara:exam-draft', JSON.stringify({ exam, topic })) } catch { /* Private browsing. */ }
    const payment = clientRequest('exam', input)
    try {
      const result = await request<{ id: number }>('/api/exams', { method: 'POST', body: JSON.stringify({ topic: input, requestId: payment.id }) })
      // Keep the payment identity until the purchased session has opened successfully.
      const next = await request<ExamSession>(`/api/exams/${result.id}`)
      payment.finish(); setSession(next); setSaved(true)
      try { sessionStorage.removeItem('jara:exam-draft') } catch { /* Private browsing. */ }
      window.history.replaceState(null, '', `/app/exam?run=${result.id}`)
      window.scrollTo(0, 0)
    } catch (e) {
      if (e instanceof Error && 'terminal' in e && e.terminal) payment.finish()
      setError(responseMessage(e))
    } finally { lock.current = false; setBusy(false) }
  }

  async function save(currentQuestion: number, options: { submit?: boolean; restart?: boolean; choice?: number; exit?: boolean } = {}) {
    if (lock.current || !session) return
    lock.current = true; setBusy(true); setError(''); setSaved(false)
    const answers = [...session.answers]
    if (options.choice !== undefined) {
      answers[session.currentQuestion] = options.choice
      setSession({ ...session, answers })
    }
    try {
      const next = await request<ExamSession>(`/api/exams/${session.id}`, { method: 'PUT', body: JSON.stringify({ answers, currentQuestion, revision: session.revision, submit: options.submit, restart: options.restart }) })
      setSession(next); setSaved(true)
      if (options.exit) { router.push('/app#automations'); return }
      if (options.choice === undefined) { window.scrollTo(0, 0); heading.current?.focus() }
    } catch (e) {
      setSession(session)
      setError(responseMessage(e))
    }
    finally { lock.current = false; setBusy(false) }
  }

  const count = session?.questions.length ?? home?.questionCount ?? 20
  const answered = session?.answers.filter((a) => a !== null).length ?? 0
  const index = session?.currentQuestion ?? 0
  const question = session?.questions[index]

  return <div className="jara-app min-h-dvh text-ink">
    <header className="flex min-h-20 flex-wrap items-center justify-between gap-3 border-b border-forest/10 bg-white px-5 py-4 sm:px-10">
      <button disabled={busy} onClick={() => void newPractice()} className="text-xl font-black tracking-tight">jara<span className="text-mandarin">.</span> <span className="ml-2 text-sm font-medium text-forest/70">Exam prep</span></button>
      <div className="flex items-center gap-3">
        <button type="button" className="hidden text-sm font-semibold sm:block" onClick={() => {
          if (document.fullscreenElement) void document.exitFullscreen().catch(() => {})
          else void document.documentElement.requestFullscreen?.().catch(() => {})
        }}>Full screen</button>
        {session && !session.submitted ? <button className={secondary} disabled={busy} onClick={() => void save(index, { exit: true })}>Save & exit</button> : <Link className={secondary} href="/app">Back to Jara</Link>}
      </div>
    </header>

    <main className="mx-auto w-full max-w-4xl px-5 py-8 sm:px-10 sm:py-12">
      {error && <div role="alert" className="mb-6 rounded-xl border border-red-200 bg-red-50 p-4 text-red-900">{error} <button className="ml-2 underline" onClick={() => window.location.reload()}>Reload</button></div>}
      {loading ? <p role="status" className="py-20 text-center">Opening your exam prep…</p> : !home ? <div className="py-10"><h1 className="mb-4 text-3xl font-bold">Open exam prep in your Jara account</h1><Link href="/app" className={primary}>Go to Jara</Link></div> : !session ? <>
        <p className="mb-3 text-sm font-bold uppercase tracking-widest text-forest/60">Your practice room</p>
        <h1 className="text-4xl font-bold sm:text-5xl">Get ready for exam day.</h1>
        <p className="mt-4 max-w-xl leading-7 text-forest/70">A complete {count}-question practice session. Select your answers, work through the paper, and get your score with explanations at the end.</p>
        <form onSubmit={start} className="mt-8 space-y-5 rounded-3xl border border-forest/10 bg-white p-6 sm:p-8">
          <label className="block font-semibold">Exam<select value={exam} disabled={busy} onChange={(e) => setExam(e.target.value)} className="mt-2 block w-full rounded-xl border border-forest/20 bg-white p-3">{EXAM_OPTIONS.map((e) => <option key={e}>{e}</option>)}</select></label>
          <label className="block font-semibold">Subjects or topics<textarea required minLength={3} maxLength={900} value={topic} disabled={busy} onChange={(e) => setTopic(e.target.value)} placeholder="e.g. Biology: cells, genetics and ecology" className="mt-2 block min-h-28 w-full rounded-xl border border-forest/20 p-3 font-normal" /></label>
          <div className="flex flex-wrap items-center justify-between gap-4 border-t border-forest/10 pt-5"><div><p className="font-bold">G$ {home.priceGd} per new paper</p><p className="mt-1 text-sm text-forest/60">AI jar: G$ {home.balanceGd.toLocaleString(undefined, { maximumFractionDigits: 2 })} · Resume and retake free</p></div><button className={primary} disabled={busy || !home.connected || home.balanceGd < home.priceGd}>{busy ? 'Preparing 20 questions…' : 'Start practice'}</button></div>
          {busy && <p role="status" className="text-sm text-forest/70">Preparing and checking your complete paper. This may take a minute.</p>}
          {(!home.connected || home.balanceGd < home.priceGd) && <p className="text-sm"><Link className="font-semibold underline" href="/app">{!home.connected ? 'Connect your account' : 'Add G$ to your AI jar'}</Link> to start a new practice.</p>}
          <p className="text-xs text-forest/50">AI-generated practice questions, not an official exam paper.</p>
        </form>
        {home.sessions.length > 0 && <section className="mt-10"><h2 className="mb-4 text-xl font-bold">Your practice sessions</h2><div className="space-y-3">{home.sessions.map((s) => <button key={s.id} disabled={busy} onClick={() => void open(s.id)} className="flex w-full items-center justify-between gap-4 rounded-2xl border border-forest/10 bg-white p-5 text-left"><div className="min-w-0"><p className="break-words font-semibold">{s.title}</p><p className="mt-1 text-sm text-forest/60">{s.submitted ? 'Completed' : `${s.answered} of ${s.count} answered`}</p></div><span className="shrink-0 text-sm font-bold">{s.submitted ? 'Results' : 'Resume'} →</span></button>)}</div></section>}
      </> : session.submitted ? <>
        <p className="text-sm font-bold uppercase tracking-widest text-forest/60">Practice complete</p>
        <h1 ref={heading} tabIndex={-1} className="mt-4 text-5xl font-bold">{session.score} <span className="text-2xl text-forest/50">/ {count}</span></h1>
        <p className="mt-3 text-xl">{Math.round((session.score ?? 0) / count * 100)}% correct</p>
        <p className="mt-3 break-words text-forest/65">{session.title}</p>
        <div className="my-7 flex flex-wrap gap-3"><button className={primary} disabled={busy} onClick={() => void save(0, { restart: true })}>Try again · free</button><button className={secondary} disabled={busy} onClick={() => void newPractice()}>New practice</button></div>
        <h2 className="mb-5 text-2xl font-bold">Review your answers</h2>
        <div className="space-y-5">{session.review?.map((q, i) => {
          const correct = session.answers[i] === q.correctOption
          return <article key={i} className="rounded-2xl border border-forest/10 bg-white p-5 sm:p-7"><p className={`mb-3 text-sm font-bold ${correct ? 'text-green-800' : 'text-red-700'}`}>Question {i + 1} · {correct ? 'Correct' : 'Incorrect'}</p><h3 className="whitespace-pre-wrap text-lg font-semibold">{q.prompt}</h3><p className="mt-4 text-sm">Your answer: <strong>{String.fromCharCode(65 + (session.answers[i] ?? 0))}. {q.options[session.answers[i] ?? 0]}</strong></p>{!correct && <p className="mt-2 text-sm text-green-800">Correct answer: <strong>{String.fromCharCode(65 + q.correctOption)}. {q.options[q.correctOption]}</strong></p>}<p className="mt-4 whitespace-pre-wrap border-t border-forest/10 pt-4 leading-7 text-forest/75">{q.explanation}</p></article>
        })}</div>
      </> : question && <>
        <div className="flex items-center justify-between gap-3 text-sm"><span className="font-bold">Question {index + 1} of {count}</span><span role="status" className="text-forest/60">{busy ? 'Saving…' : saved ? 'Progress saved' : `${answered} answered`}</span></div>
        <div role="progressbar" aria-label="Questions answered" aria-valuenow={answered} aria-valuemin={0} aria-valuemax={count} className="mt-3 h-2 overflow-hidden rounded-full bg-forest/10"><div className="h-full bg-forest transition-all" style={{ width: `${answered / count * 100}%` }} /></div>
        <p className="mt-8 text-sm font-semibold text-forest/60">{question.topic}</p>
        <h1 ref={heading} tabIndex={-1} className="mt-3 whitespace-pre-wrap text-2xl leading-snug font-bold sm:text-3xl">{question.prompt}</h1>
        <fieldset disabled={busy} className="my-8 grid gap-3"><legend className="sr-only">Select your answer</legend>{question.options.map((option, choice) => <label key={choice} className={`flex cursor-pointer items-start gap-4 rounded-2xl border-2 p-4 transition-colors sm:p-5 ${session.answers[index] === choice ? 'border-forest bg-forest/10' : 'border-forest/10 bg-white hover:border-forest/40'}`}><input type="radio" name={`question-${index}`} value={choice} checked={session.answers[index] === choice} onChange={() => void save(index, { choice })} className="mt-1 size-5 shrink-0 accent-forest" /><span className="font-bold">{String.fromCharCode(65 + choice)}.</span><span className="min-w-0 whitespace-pre-wrap break-words leading-6">{option}</span></label>)}</fieldset>
        <div className="flex items-center justify-between gap-4"><button className={secondary} disabled={busy || index === 0} onClick={() => void save(index - 1)}>Previous</button>{index < count - 1 ? <button className={primary} disabled={busy || session.answers[index] === null} onClick={() => void save(index + 1)}>Next question →</button> : <button className={primary} disabled={busy || answered !== count} onClick={() => void save(index, { submit: true })}>{busy ? 'Saving…' : 'Finish & see results'}</button>}</div>
        <p className="mt-4 text-center text-sm text-forest/60">{answered === count ? 'All questions answered. You can review your choices before finishing.' : 'Select one answer for each question. You can change your choices before finishing.'}</p>
        <nav aria-label="Question navigation" className="mt-10 border-t border-forest/10 pt-6"><p className="mb-3 text-xs font-bold uppercase tracking-wider text-forest/60">{answered} of {count} answered</p><div className="flex flex-wrap gap-2">{session.questions.map((_, i) => <button key={i} aria-label={`Question ${i + 1}${session.answers[i] === null ? ', unanswered' : ', answered'}`} aria-current={index === i ? 'step' : undefined} disabled={busy} onClick={() => void save(i)} className={`size-10 rounded-lg border text-sm font-bold ${index === i ? 'border-forest bg-forest text-white' : session.answers[i] !== null ? 'border-forest/20 bg-forest/10' : 'border-forest/15 bg-white'}`}>{i + 1}</button>)}</div></nav>
      </>}
    </main>
  </div>
}
