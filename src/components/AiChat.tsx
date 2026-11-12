'use client'

import Link from 'next/link'
import { useRouter } from 'next/navigation'
import { clientRequest } from '@/lib/client-request'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Icon, type IconName } from './Icon'
import { Markdown } from './Markdown'

interface Tool {
  id: string
  name: string
  blurb: string
  placeholder: string
  priceGd: number
  followUpGd: number
}
interface ChatSummary {
  id: string
  tool: string
  title: string
  updatedAt: number
}
interface Msg {
  id: number | string
  role: 'user' | 'assistant'
  content: string
  costGd: number
  pending?: boolean
}
interface Home {
  user: { name: string | null; connected: boolean }
  chats: ChatSummary[]
  balanceGd: number
  aiJarGd: number
  tools: Tool[]
}

const TOOL_ICON: Record<string, IconName> = {
  research: 'chart',
  assignment: 'check',
  brainstorm: 'sparkle',
  exam: 'star',
  cv: 'bot',
  opportunities: 'arrow',
  hustle: 'coins',
  content: 'chat',
}
const gd = (n: number) => Math.floor(n).toLocaleString()

export function AiChat() {
  const router = useRouter()
  const [home, setHome] = useState<Home | null | 'signed-out'>(null)
  const [chatId, setChatId] = useState<string | null>(null)
  const [toolId, setToolId] = useState('research')
  const [messages, setMessages] = useState<Msg[]>([])
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [drawer, setDrawer] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const endRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const [hasRetry, setHasRetry] = useState(false)
  const retry = useRef<{ text: string; chatId: string | null; tool: string } | null>(null)

  const flash = (t: string) => {
    setToast(t)
    window.setTimeout(() => setToast(null), 2500)
  }

  const loadHome = useCallback(async () => {
    const res = await fetch('/api/ai/chats', { cache: 'no-store' })
    if (res.status === 401) return setHome('signed-out')
    setHome((await res.json()) as Home)
  }, [])

  useEffect(() => {
    // Initial data load, plus an optional ?tool= preset from the dashboard shortcuts.
    const preset = new URLSearchParams(window.location.search).get('tool')
    if (preset === 'exam') { router.replace('/app/exam'); return }
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (preset) setToolId(preset)
    void loadHome()
  }, [loadHome, router])

  useEffect(() => {
    endRef.current?.scrollIntoView({ behavior: 'smooth', block: 'end' })
  }, [messages])

  const openChat = async (id: string) => {
    setDrawer(false)
    setError(null)
    const res = await fetch(`/api/ai/chats/${id}`, { cache: 'no-store' })
    if (!res.ok) return
    const data = (await res.json()) as { chat: ChatSummary; messages: Msg[] }
    setChatId(id)
    setToolId(data.chat.tool)
    setMessages(data.messages)
  }

  const newChat = (tool?: string) => {
    if (tool === 'exam') { router.push('/app/exam'); return }
    setDrawer(false)
    setChatId(null)
    setMessages([])
    setError(null)
    if (tool) setToolId(tool)
    window.setTimeout(() => inputRef.current?.focus(), 50)
  }

  const removeChat = async (id: string) => {
    await fetch(`/api/ai/chats/${id}`, { method: 'DELETE' })
    if (id === chatId) newChat()
    void loadHome()
  }

  const send = async () => {
    if (toolId === 'exam' && !chatId) { router.push(`/app/exam?topic=${encodeURIComponent(input)}`); return }
    const text = input.trim()
    if (!text || busy || typeof home !== 'object' || !home) return
    setBusy(true)
    setError(null)
    setInput('')
    const tempUser: Msg = { id: `u${Date.now()}`, role: 'user', content: text, costGd: 0 }
    const tempAi: Msg = { id: `a${Date.now()}`, role: 'assistant', content: '', costGd: 0, pending: true }
    setMessages((m) => [...m, tempUser, tempAi])
    if (!retry.current) {
      try { retry.current = JSON.parse(window.sessionStorage.getItem('jara:ai-retry') ?? 'null') } catch { /* unavailable */ }
    }
    const original = retry.current?.text === text && retry.current.tool === toolId ? retry.current : { text, chatId, tool: toolId }
    retry.current = original
    setHasRetry(true)
    try { window.sessionStorage.setItem('jara:ai-retry', JSON.stringify(original)) } catch { /* unavailable */ }
    const request = clientRequest('ai-chat', original)
    let completed = false
    try {
      const res = await fetch('/api/ai/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ...original, requestId: request.id }),
      })
      if (!res.ok || !res.body) {
        const j = (await res.json().catch(() => ({}))) as { error?: string }
        throw new Error(j.error ?? 'Something went wrong')
      }
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      let failed: string | null = null
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        let nl: number
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl)
          buf = buf.slice(nl + 1)
          if (!line.trim()) continue
          const ev = JSON.parse(line) as { t: string; v?: string; chatId?: string; messageId?: number; costGd?: number; message?: string; demo?: boolean; terminal?: boolean }
          if (ev.t === 'chat' && ev.chatId) setChatId(ev.chatId)
          else if (ev.t === 'delta' && ev.v) setMessages((m) => m.map((x) => (x.id === tempAi.id ? { ...x, content: x.content + ev.v } : x)))
          else if (ev.t === 'done') {
            completed = true
            request.finish()
            retry.current = null
            setHasRetry(false)
            try { window.sessionStorage.removeItem('jara:ai-retry') } catch { /* unavailable */ }
            setMessages((m) => m.map((x) => (x.id === tempAi.id ? { ...x, id: ev.messageId ?? x.id, costGd: ev.costGd ?? 0, pending: false } : x)))
          } else if (ev.t === 'error') {
            failed = ev.message ?? 'Something went wrong'
            if (ev.terminal) {
              request.finish()
              retry.current = null
              setHasRetry(false)
              try { window.sessionStorage.removeItem('jara:ai-retry') } catch { /* unavailable */ }
            }
          }
        }
      }
      if (failed) throw new Error(failed)
      if (!completed) throw new Error('The connection ended before confirmation. Retry to check the same request.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Something went wrong')
      setMessages((m) => m.filter((x) => x.id !== tempAi.id && x.id !== tempUser.id))
      setInput(text)
    } finally {
      setBusy(false)
      void loadHome()
    }
  }

  if (home === null) return <div className="grid min-h-dvh place-items-center bg-cream font-bold text-ink/50">Loading Jara AI…</div>
  if (home === 'signed-out' || !home.user.connected) {
    return (
      <main className="grid min-h-dvh place-items-center bg-forest px-4">
        <div className="app-card w-full max-w-md p-7 text-center">
          <span className="mx-auto grid h-14 w-14 place-items-center rounded-2xl bg-[#edf2e8] text-forest">
            <Icon name="sparkle" className="h-7 w-7" />
          </span>
          <h1 className="mt-4 text-3xl font-semibold tracking-tight">Jara AI</h1>
          <p className="mt-2 font-semibold text-ink/65">Set up Jara first. It takes a minute, then your G$ pays for research, assignments and more.</p>
          <Link href="/app" className="app-button justify-center bg-forest text-cream hover:bg-forest-soft disabled:opacity-60 mt-6">
            Set up Jara →
          </Link>
        </div>
      </main>
    )
  }

  const tool = home.tools.find((t) => t.id === toolId) ?? home.tools[0]
  const isFollowUp = messages.some((m) => m.role === 'assistant' && !m.pending)
  const price = isFollowUp ? tool.followUpGd : tool.priceGd
  const canAfford = home.aiJarGd >= price || hasRetry

  const sidebar = (
    <div className="flex h-full flex-col bg-forest text-cream">
      <div className="flex items-center justify-between px-4 pt-4 pb-3">
        <Link href="/app" className="flex items-center gap-2 font-bold">
          <span className="grid h-8 w-8 place-items-center rounded-lg border-2 border-ink bg-crest text-ink">
            <Icon name="jar" className="h-4.5 w-4.5" />
          </span>
          Jara AI
        </Link>
        <button onClick={() => setDrawer(false)} className="rounded-lg p-1.5 hover:bg-cream/10 lg:hidden" aria-label="Close menu">
          <Icon name="x" className="h-5 w-5" />
        </button>
      </div>
      <div className="px-3">
        <button onClick={() => newChat()} className="flex w-full items-center gap-2 rounded-xl border-2 border-cream/20 px-3 py-2.5 text-sm font-bold hover:bg-cream/10">
          <Icon name="plus" className="h-4 w-4" /> New chat
        </button>
      </div>
      <p className="px-4 pt-5 pb-2 text-[11px] font-bold tracking-widest text-cream/40 uppercase">Your chats</p>
      <ul className="min-h-0 flex-1 overflow-y-auto px-2 pb-3">
        {home.chats.map((c) => (
          <li key={c.id} className="group relative">
            <button
              onClick={() => openChat(c.id)}
              className={`flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-sm font-semibold ${c.id === chatId ? 'bg-cream/15' : 'hover:bg-cream/10'}`}
            >
              <Icon name={TOOL_ICON[c.tool] ?? 'chat'} className="h-4 w-4 shrink-0 text-crest" />
              <span className="truncate pr-6">{c.title}</span>
            </button>
            <button onClick={() => removeChat(c.id)} className="absolute top-1/2 right-1.5 hidden -translate-y-1/2 rounded p-1 text-cream/50 group-hover:block hover:text-cream" aria-label="Delete chat">
              <Icon name="x" className="h-3.5 w-3.5" strokeWidth={3} />
            </button>
          </li>
        ))}
        {!home.chats.length && <li className="px-3 py-2 text-sm font-semibold text-cream/40">No chats yet.</li>}
      </ul>
      <div className="border-t border-cream/10 p-4">
        <p className="text-[11px] font-bold tracking-widest text-cream/40 uppercase">Your AI jar</p>
        <p className="mt-0.5 text-xl font-bold text-crest">G$ {gd(home.aiJarGd)}</p>
        <p className="text-xs font-semibold text-cream/50">Fills every day as Jara claims your G$</p>
        <Link href="/app" className="mt-3 inline-flex items-center gap-1.5 text-sm font-bold text-cream/70 hover:text-cream">
          <Icon name="undo" className="h-4 w-4" /> Back to my jars
        </Link>
      </div>
    </div>
  )

  return (
    <div className="jara-app flex h-dvh">
      {/* Sidebar */}
      <aside className="hidden w-72 shrink-0 border-r border-ink/10 lg:block">{sidebar}</aside>
      {drawer && (
        <div className="fixed inset-0 z-40 lg:hidden">
          <button className="absolute inset-0 bg-ink/50" onClick={() => setDrawer(false)} aria-label="Close menu" />
          <aside className="absolute inset-y-0 left-0 w-[82%] max-w-xs border-r border-ink/10">{sidebar}</aside>
        </div>
      )}

      {/* Main */}
      <main className="flex min-w-0 flex-1 flex-col">
        <header className="flex items-center justify-between gap-3 border-b border-ink/10 bg-white px-4 py-4">
          <div className="flex min-w-0 items-center gap-2">
            <button onClick={() => setDrawer(true)} className="rounded-lg p-1.5 hover:bg-ink/5 lg:hidden" aria-label="Open menu">
              <svg viewBox="0 0 24 24" className="h-6 w-6" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round">
                <path d="M4 7h16M4 12h16M4 17h16" />
              </svg>
            </button>
            <span className="flex items-center gap-2 rounded-full bg-forest px-3 py-1.5 text-sm font-bold text-cream">
              <Icon name={TOOL_ICON[tool.id] ?? 'sparkle'} className="h-4 w-4 text-crest" /> {tool.name}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <Link href="/app#overview" className="rounded-full bg-[#e5eddc] px-3 py-2 text-xs font-bold text-forest" aria-label="Manage your AI jar">AI jar · G$ {gd(home.aiJarGd)}</Link>
            <button onClick={() => newChat()} className="rounded-lg p-1.5 hover:bg-ink/5 lg:hidden" aria-label="New chat">
              <Icon name="plus" className="h-5 w-5" />
            </button>
          </div>
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto">
          {messages.length === 0 ? (
            <div className="mx-auto max-w-3xl px-4 pt-10 pb-6 sm:pt-16">
              <h1 className="mx-auto max-w-xl text-center text-3xl leading-tight font-bold tracking-[-0.045em] sm:text-4xl">
                A little help with your next big idea.
              </h1>
              <p className="mt-3 text-center font-semibold text-ink/60">Pick a helper. Pay from your AI jar. Keep your answer as a PDF.</p>
              <div className="mt-8 grid grid-cols-2 gap-3 sm:grid-cols-4">
                {home.tools.map((t) => (
                  <button
                    key={t.id}
                    onClick={() => {
                      if (t.id === 'exam') { router.push('/app/exam'); return }
                      setToolId(t.id)
                      inputRef.current?.focus()
                    }}
                    className={`flex flex-col rounded-2xl border p-3.5 text-left transition ${
                      t.id === tool.id ? 'border-forest bg-forest text-cream' : 'border-ink/15 bg-white hover:border-ink'
                    }`}
                  >
                    <span className={`grid h-9 w-9 place-items-center rounded-xl ${t.id === tool.id ? 'bg-crest text-ink' : 'bg-cream'}`}>
                      <Icon name={TOOL_ICON[t.id] ?? 'sparkle'} className="h-5 w-5" />
                    </span>
                    <span className="mt-3 leading-tight font-bold">{t.name}</span>
                    <span className={`mt-1 line-clamp-2 text-xs font-semibold ${t.id === tool.id ? 'text-cream/70' : 'text-ink/55'}`}>{t.blurb}</span>
                    <span className={`mt-2 text-xs font-bold ${t.id === tool.id ? 'text-crest' : 'text-mandarin'}`}>G$ {t.priceGd}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            <div className="mx-auto max-w-3xl px-4 py-6">
              {messages.map((m) =>
                m.role === 'user' ? (
                  <div key={m.id} className="mb-6 flex justify-end">
                    <p className="max-w-[85%] rounded-3xl rounded-br-md bg-forest px-4 py-3 font-semibold whitespace-pre-wrap text-cream">{m.content}</p>
                  </div>
                ) : (
                  <div key={m.id} className="mb-8 flex gap-3">
                    <span className="mt-1 grid h-8 w-8 shrink-0 place-items-center rounded-lg border-2 border-ink bg-crest">
                      <Icon name="sparkle" className="h-4 w-4" />
                    </span>
                    <div className="min-w-0 flex-1">
                      {m.content ? (
                        <Markdown>{m.content}</Markdown>
                      ) : (
                        <p className="flex items-center gap-2 pt-1.5 font-bold text-ink/50">
                          <span className="h-2 w-2 animate-pulse rounded-full bg-mandarin" /> Jara is thinking…
                        </p>
                      )}
                      {!m.pending && typeof m.id === 'number' && (
                        <div className="mt-3 flex flex-wrap items-center gap-2">
                          <a
                            href={`/api/ai/pdf/${m.id}`}
                            className="app-button-secondary min-h-9 px-3 py-1.5 text-xs"
                          >
                            <svg viewBox="0 0 24 24" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth={2.5} strokeLinecap="round" strokeLinejoin="round">
                              <path d="M12 4v11M7 10l5 5 5-5M5 20h14" />
                            </svg>
                            Download PDF
                          </a>
                          <button
                            onClick={() => navigator.clipboard?.writeText(m.content).then(() => flash('Copied'), () => undefined)}
                            className="inline-flex items-center gap-1.5 rounded-xl border-2 border-ink/15 bg-white px-3 py-1.5 text-sm font-bold hover:border-ink"
                          >
                            Copy
                          </button>
                          {m.costGd > 0 && <span className="text-xs font-bold text-ink/45">Paid G$ {m.costGd} from your AI jar</span>}
                        </div>
                      )}
                    </div>
                  </div>
                ),
              )}
              <div ref={endRef} />
            </div>
          )}
        </div>

        {/* Composer */}
        <div className="border-t border-ink/10 bg-[#f7f8f2] px-4 pt-3 pb-4">
          <div className="mx-auto max-w-3xl">
            {error && <p className="mb-2 rounded-xl bg-red-50 px-3 py-2 text-sm font-bold text-red-800">{error}</p>}
            <div className="rounded-2xl border border-ink/20 bg-white focus-within:ring-2 focus-within:ring-forest/30">
              <textarea
                ref={inputRef}
                value={input}
                onChange={(e) => {
                  setInput(e.target.value)
                  e.target.style.height = 'auto'
                  e.target.style.height = `${Math.min(e.target.scrollHeight, 220)}px`
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) {
                    e.preventDefault()
                    void send()
                  }
                }}
                rows={1}
                aria-label="Your question"
                placeholder={isFollowUp ? 'Ask a follow-up…' : tool.placeholder}
                className="block max-h-56 w-full resize-none rounded-3xl bg-transparent px-5 pt-4 pb-2 text-[15.5px] font-medium outline-none placeholder:text-ink/40"
              />
              <div className="flex flex-wrap items-center justify-between gap-2 px-3 pb-3">
                {isFollowUp || chatId ? (
                  <span className="pl-2 text-xs font-bold text-ink/45">{tool.name} · follow-ups G$ {tool.followUpGd}</span>
                ) : (
                  <select
                    value={tool.id}
                    onChange={(e) => { if (e.target.value === 'exam') router.push('/app/exam'); else setToolId(e.target.value) }}
                    className="rounded-full border-2 border-ink/15 bg-cream px-3 py-1.5 text-sm font-bold outline-none"
                    aria-label="Helper"
                  >
                    {home.tools.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}: G$ {t.priceGd}
                      </option>
                    ))}
                  </select>
                )}
                <button
                  onClick={send}
                  disabled={busy || !input.trim() || !canAfford}
                  className="flex items-center gap-2 rounded-xl bg-forest px-4 py-2.5 text-sm font-bold text-cream disabled:opacity-40"
                >
                  {busy ? 'Thinking…' : `Ask · G$ ${price}`}
                  <Icon name="arrow" className="h-4 w-4" strokeWidth={2.75} />
                </button>
              </div>
            </div>
            <p className="mt-2 text-center text-[11px] font-semibold text-ink/40">
              {canAfford ? 'Only charged when you get an answer. Check facts and write assignments in your own words.' : 'Not enough G$ yet. Your jars fill every day.'}
            </p>
          </div>
        </div>
      </main>

      {toast && (
        <div className="fixed inset-x-0 bottom-28 z-50 flex justify-center px-4">
          <p className="animate-pop rounded-full bg-ink px-5 py-2.5 font-bold text-cream">{toast}</p>
        </div>
      )}
    </div>
  )
}
