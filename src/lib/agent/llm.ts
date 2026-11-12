import { serverConfig } from '../env'
import { rateLimit } from '../ratelimit'

// Minimal OpenAI Chat Completions client. Points at the AntSeed buyer proxy by
// default (localhost:8377), which routes to a peer and settles in USDC on Base.
// Any OpenAI-compatible endpoint works via LLM_BASE_URL.

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string | null
  tool_calls?: ToolCall[]
  tool_call_id?: string
}

export interface ToolCall {
  id: string
  type: 'function'
  function: { name: string; arguments: string }
}

export interface ToolDef {
  type: 'function'
  function: { name: string; description: string; parameters: Record<string, unknown> }
}

/**
 * `think: false` turns off the model's hidden reasoning for simple tasks (picking from a list),
 * so the whole token budget goes to the answer. Only sent to DeepSeek models, which support it.
 */
export async function chat(messages: ChatMessage[], tools: ToolDef[], maxTokens = 600, opts: { think?: boolean; timeoutMs?: number } = {}): Promise<ChatMessage> {
  const cfg = serverConfig().llm
  if (cfg.disabled) throw new Error('LLM disabled')
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    authorization: `Bearer ${cfg.apiKey}`,
  }
  if (cfg.antseedPeer) headers['x-antseed-pin-peer'] = cfg.antseedPeer
  // Global budget guard: every call costs USDC on AntSeed. Past the daily cap the
  // agent falls back to rules and AI helpers say "busy" without charging anyone.
  if (!rateLimit('llm:global', cfg.dailyCallCap, 24 * 60 * 60_000)) throw new Error('LLM daily call cap reached')
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: cfg.model,
      messages,
      ...(tools.length ? { tools, tool_choice: 'auto' } : {}),
      ...(opts.think === false && /deepseek/i.test(cfg.model) ? { thinking: { type: 'disabled' } } : {}),
      temperature: 0.3,
      max_tokens: maxTokens,
    }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? 30_000),
  })
  if (!res.ok) throw new Error(`LLM HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`)
  const json = (await res.json()) as { choices?: { message?: ChatMessage }[] }
  const msg = json.choices?.[0]?.message
  if (!msg) throw new Error('LLM returned no message')
  return msg
}

let probe: { ok: boolean; at: number } | null = null

/** Is the LLM endpoint (AntSeed proxy by default) answering? Cached for 60s. */
export async function llmReachable(): Promise<boolean> {
  const cfg = serverConfig().llm
  if (cfg.disabled) return false
  if (probe && Date.now() - probe.at < 60_000) return probe.ok
  let ok = false
  try {
    const res = await fetch(`${cfg.baseUrl}/models`, {
      headers: { authorization: `Bearer ${cfg.apiKey}` },
      signal: AbortSignal.timeout(1500),
    })
    ok = res.ok
  } catch {
    ok = false
  }
  probe = { ok, at: Date.now() }
  return ok
}

/** Stream a plain chat completion (no tools). Yields text as it arrives. */
export async function* chatStream(messages: ChatMessage[], maxTokens = 1500): AsyncGenerator<string> {
  const cfg = serverConfig().llm
  if (cfg.disabled) throw new Error('LLM disabled')
  if (!rateLimit('llm:global', cfg.dailyCallCap, 24 * 60 * 60_000)) throw new Error('LLM daily call cap reached')
  const headers: Record<string, string> = { 'content-type': 'application/json', authorization: `Bearer ${cfg.apiKey}` }
  if (cfg.antseedPeer) headers['x-antseed-pin-peer'] = cfg.antseedPeer
  const res = await fetch(`${cfg.baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ model: cfg.model, messages, stream: true, temperature: 0.4, max_tokens: maxTokens,
      ...(/deepseek/i.test(cfg.model) ? { thinking: { type: 'disabled' } } : {}),
    }),
    signal: AbortSignal.timeout(180_000),
  })
  if (!res.ok || !res.body) throw new Error(`LLM HTTP ${res.status}: ${(await res.text().catch(() => '')).slice(0, 200)}`)
  const reader = res.body.getReader()
  const decoder = new TextDecoder()
  let buf = ''
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })
    let nl: number
    while ((nl = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, nl).trim()
      buf = buf.slice(nl + 1)
      if (!line.startsWith('data:')) continue
      const data = line.slice(5).trim()
      if (data === '[DONE]') return
      try {
        const json = JSON.parse(data) as { choices?: { delta?: { content?: string | null } }[] }
        const piece = json.choices?.[0]?.delta?.content
        if (piece) yield piece
      } catch {
        /* keep-alive or partial line */
      }
    }
  }
}
