import { jarSpendable } from './jars'
import { randomBytes } from 'node:crypto'
import { formatEther, parseEther } from 'viem'
import { chatStream, llmReachable, type ChatMessage } from './agent/llm'
import { AI_BASE_PROMPT, AI_TOOLS, followUpPrice, type AiToolId } from './ai-tools'
import { PaymentFailedError, spendGd } from './spend'
import { moneyRequest } from './money-request'
import { atomic, run } from './db'
import { serverConfig } from './env'
import { syncJars, withUserLock } from './jars'
import type { User } from './users'

// Jara AI: ChatGPT-style conversations. Every answer is paid in G$ from the
// AI jar (first answer at the helper's price, follow-ups cheaper), charged only
// after the answer has fully arrived.

export interface ChatSummary {
  id: string
  tool: AiToolId
  title: string
  updatedAt: number
}
export interface ChatMsg {
  id: number
  role: 'user' | 'assistant'
  content: string
  costGd: number
  createdAt: number
}

export async function listChats(userId: string): Promise<ChatSummary[]> {
  const r = await run('SELECT id, tool, title, updated_at FROM ai_chats WHERE user_id = ? ORDER BY updated_at DESC LIMIT 50', [userId])
  return r.rows.map((x) => ({ id: x.id as string, tool: x.tool as AiToolId, title: x.title as string, updatedAt: Number(x.updated_at) }))
}

export async function getChat(userId: string, chatId: string): Promise<{ chat: ChatSummary; messages: ChatMsg[] } | null> {
  const c = await run('SELECT id, tool, title, updated_at FROM ai_chats WHERE id = ? AND user_id = ?', [chatId, userId])
  if (!c.rows.length) return null
  const m = await run('SELECT id, role, content, cost_gd, created_at FROM ai_messages WHERE chat_id = ? ORDER BY id', [chatId])
  const x = c.rows[0]
  return {
    chat: { id: x.id as string, tool: x.tool as AiToolId, title: x.title as string, updatedAt: Number(x.updated_at) },
    messages: m.rows.map((r) => ({ id: Number(r.id), role: r.role as 'user' | 'assistant', content: r.content as string, costGd: Number(r.cost_gd), createdAt: Number(r.created_at) })),
  }
}

export async function deleteChat(userId: string, chatId: string) {
  const own = await run('SELECT 1 FROM ai_chats WHERE id = ? AND user_id = ?', [chatId, userId])
  if (!own.rows.length) return
  const pending = (await run('SELECT data FROM money_requests WHERE user_id = ? AND result IS NULL AND data IS NOT NULL', [userId])).rows
  if (pending.some((r) => (JSON.parse(String(r.data)) as { chatId?: string }).chatId === chatId)) throw new Error('This chat has an unfinished request. Finish it before deleting the chat.')
  await run('DELETE FROM ai_messages WHERE chat_id = ?', [chatId])
  await run('DELETE FROM ai_chats WHERE id = ?', [chatId])
}

/** One assistant message owned by this user, for PDF export. */
export async function getOwnedMessage(userId: string, messageId: number) {
  const r = await run(
    `SELECT m.id, m.content, m.created_at, c.tool, c.title, c.id AS chat_id
       FROM ai_messages m JOIN ai_chats c ON c.id = m.chat_id
      WHERE m.id = ? AND c.user_id = ? AND m.role = 'assistant'`,
    [messageId, userId],
  )
  if (!r.rows.length) return null
  const x = r.rows[0]
  const q = await run(`SELECT content FROM ai_messages WHERE chat_id = ? AND role = 'user' AND id < ? ORDER BY id DESC LIMIT 1`, [x.chat_id as string, messageId])
  return { content: x.content as string, createdAt: Number(x.created_at), tool: x.tool as AiToolId, title: x.title as string, question: (q.rows[0]?.content as string) ?? '' }
}

export type StreamEvent =
  | { t: 'chat'; chatId: string; title: string; priceGd: number }
  | { t: 'delta'; v: string }
  | { t: 'done'; messageId: number; costGd: number; demo: boolean }
  | { t: 'error'; message: string; terminal?: boolean }

const titleFrom = (text: string) => {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > 60 ? `${t.slice(0, 57)}…` : t
}

/**
 * Send a message in a chat (creating it if chatId is empty) and stream the answer.
 * The caller holds nothing; this takes the user lock for the whole answer.
 */
interface ChatRequestData {
  type: 'ai-chat'
  chatId: string
  tool: AiToolId
  text: string
  priceGd: number
  history: ChatMsg[]
  answer?: string
  demo?: boolean
}

export async function* sendChat(user: User, input: { requestId: string; chatId?: string; tool: AiToolId; text: string }): AsyncGenerator<StreamEvent> {
  const events: StreamEvent[] = []
  let resolveNext: (() => void) | null = null
  let finished = false
  const push = (event: StreamEvent) => { events.push(event); resolveNext?.() }
  const work = withUserLock(user.id, async () => {
    const text = input.text.trim().slice(0, 4000)
    if (text.length < 2) throw new Error('Type a question first.')
    const request = await moneyRequest<ChatRequestData>(user.id, `ai-chat:${input.requestId}`, { chatId: input.chatId ?? '', tool: input.tool, text })
    if (!request.data) {
      const existing = input.chatId ? await getChat(user.id, input.chatId) : null
      if (input.chatId && !existing) throw new Error('Chat not found.')
      const tool = existing?.chat.tool ?? input.tool
      const history = existing?.messages ?? []
      const priceGd = history.some((m) => m.role === 'assistant') ? followUpPrice(tool) : AI_TOOLS[tool].priceGd
      await syncJars(user)
      if ((await jarSpendable(user, 'ai')) < parseEther(String(priceGd))) throw new Error(`This costs G$ ${priceGd}. Add money to your AI jar first; your other jars are protected.`)
      const chatId = input.chatId || `c_${randomBytes(8).toString('hex')}`
      const data: ChatRequestData = { type: 'ai-chat', chatId, tool, text, priceGd, history }
      await atomic(async (tx) => {
        if (!input.chatId) await tx.execute({ sql: 'INSERT INTO ai_chats(id, user_id, tool, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', args: [chatId, user.id, tool, titleFrom(text), Date.now(), Date.now()] })
        await tx.execute({ sql: "INSERT INTO ai_messages(chat_id, role, content, created_at) VALUES (?, 'user', ?, ?)", args: [chatId, text, Date.now()] })
        await tx.execute({ sql: 'UPDATE money_requests SET data = ? WHERE id = ?', args: [JSON.stringify(data), request.id] })
      })
      request.data = data
    }
    const data = request.data
    push({ t: 'chat', chatId: data.chatId, title: titleFrom(data.text), priceGd: data.priceGd })
    if (request.result) {
      push({ t: 'delta', v: data.answer ?? '' })
      push(request.result as StreamEvent)
      return
    }
    if (!data.answer) {
      const reachable = await llmReachable()
      if (!reachable) {
        if (serverConfig().chain.mode !== 'mock') throw new Error('Jara AI is offline. No payment was started.')
        data.answer = `# Demo preview\n\nJara AI is not connected. You were not charged.\n\n**You asked:** ${text}`
        data.demo = true
        push({ t: 'delta', v: data.answer })
      } else {
        const messages: ChatMessage[] = [
          { role: 'system', content: `${AI_BASE_PROMPT}\n\n${AI_TOOLS[data.tool].system}` },
          ...data.history.slice(-12).map((m) => ({ role: m.role, content: m.content })),
          { role: 'user', content: data.text },
        ]
        let answer = ''
        // A partial stream is not a completed, chargeable answer.
        for await (const piece of chatStream(messages, AI_TOOLS[data.tool].maxTokens)) {
          answer += piece
          push({ t: 'delta', v: piece })
        }
        if (!answer.trim()) throw new Error('Jara AI returned no answer. No payment was started.')
        data.answer = answer.trim()
      }
      await request.save(data)
    } else push({ t: 'delta', v: data.answer })
    push(await finishChatPayment(user, request.id, data))
  }).catch((err) => {
    console.warn('[ai-chat]', err instanceof Error ? err.message : err)
    push({ t: 'error', message: err instanceof Error ? err.message : 'Could not confirm the result. Retry the same request to check it.' })
  }).finally(() => { finished = true; resolveNext?.() })
  for (;;) {
    if (events.length) { yield events.shift()!; continue }
    if (finished) break
    await new Promise<void>((resolve) => { resolveNext = resolve })
    resolveNext = null
  }
  await work
}

async function finishChatPayment(user: User, id: string, data: ChatRequestData): Promise<StreamEvent> {
  const priceGd = data.demo ? 0 : data.priceGd
  const cost = parseEther(String(priceGd))
  let hash: string | undefined
  try { hash = data.demo ? undefined : (await spendGd(user, cost, { id, jar: 'ai' })).hash }
  catch (err) {
    if (!(err instanceof PaymentFailedError)) throw err
    const result: StreamEvent = { t: 'error', message: err.message, terminal: true }
    await run('UPDATE money_requests SET result = ? WHERE id = ?', [JSON.stringify(result), id])
    return result
  }
  return atomic(async (tx) => {
    const row = (await tx.execute({ sql: 'SELECT result FROM money_requests WHERE id = ?', args: [id] })).rows[0]
    if (row.result) return JSON.parse(String(row.result)) as StreamEvent
    const saved = await tx.execute({ sql: "INSERT INTO ai_messages(chat_id, role, content, cost_gd, created_at) VALUES (?, 'assistant', ?, ?, ?)", args: [data.chatId, data.answer!, priceGd, Date.now()] })
    await tx.execute({ sql: 'UPDATE ai_chats SET updated_at = ? WHERE id = ?', args: [Date.now(), data.chatId] })
    if (!data.demo) {
      await tx.execute({ sql: 'INSERT INTO ai_runs(user_id, tool, input, output, cost_gd, demo, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)', args: [user.id, data.tool, data.text, data.answer!, priceGd, Date.now()] })
      await tx.execute({ sql: `INSERT INTO activity(user_id, type, jar, amount_wei, tx_hash, title, detail, operation_id, created_at) VALUES (?, 'ai', 'ai', ?, ?, ?, ?, ?, ?)`, args: [user.id, String(cost), hash!, `${AI_TOOLS[data.tool].name}: ${titleFrom(data.text)}`, `Paid G$ ${formatEther(cost)} from your AI jar`, id, Date.now()] })
    }
    const result: StreamEvent = { t: 'done', messageId: Number(saved.lastInsertRowid), costGd: priceGd, demo: Boolean(data.demo) }
    await tx.execute({ sql: 'UPDATE money_requests SET result = ? WHERE id = ?', args: [JSON.stringify(result), id] })
    return result
  })
}

export async function recoverChatPayments(user: User) {
  const rows = (await run('SELECT * FROM money_requests WHERE user_id = ? AND result IS NULL AND data IS NOT NULL AND id LIKE ?', [user.id, `${user.id}:ai-chat:%`])).rows
  for (const row of rows) {
    const data = JSON.parse(String(row.data)) as ChatRequestData
    if (data.type === 'ai-chat' && data.answer) await withUserLock(user.id, () => finishChatPayment(user, String(row.id), data)).catch(() => undefined)
  }
}
