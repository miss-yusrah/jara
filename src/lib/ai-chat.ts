import { randomBytes } from 'node:crypto'
import { formatEther, parseEther } from 'viem'
import { chatStream, llmReachable, type ChatMessage } from './agent/llm'
import { AI_BASE_PROMPT, AI_TOOLS, followUpPrice, type AiToolId } from './ai-tools'
import { gdBalance, sendGdFromAgent, treasuryAddress } from './chain'
import { run } from './db'
import { serverConfig } from './env'
import { debitJars, syncJars, withUserLock } from './jars'
import { logActivity, type User } from './users'
import { decryptAgentKey } from './wallets'

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
  | { t: 'error'; message: string }

const titleFrom = (text: string) => {
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > 60 ? `${t.slice(0, 57)}…` : t
}

/**
 * Send a message in a chat (creating it if chatId is empty) and stream the answer.
 * The caller holds nothing; this takes the user lock for the whole answer.
 */
export async function* sendChat(user: User, input: { chatId?: string; tool: AiToolId; text: string }): AsyncGenerator<StreamEvent> {
  const text = input.text.trim().slice(0, 4000)
  if (text.length < 2) {
    yield { t: 'error', message: 'Type a question first.' }
    return
  }

  // Resolve or create the chat (ownership checked).
  let chatId = input.chatId ?? ''
  let tool = input.tool
  let history: ChatMsg[] = []
  if (chatId) {
    const existing = await getChat(user.id, chatId)
    if (!existing) {
      yield { t: 'error', message: 'Chat not found.' }
      return
    }
    tool = existing.chat.tool
    history = existing.messages
  }
  const isFollowUp = history.some((m) => m.role === 'assistant')
  const priceGd = isFollowUp ? followUpPrice(tool) : AI_TOOLS[tool].priceGd
  const cost = parseEther(String(priceGd))

  // Everything that touches the balance runs under the user's lock.
  const events: StreamEvent[] = []
  let resolveNext: (() => void) | null = null
  let finished = false
  const push = (e: StreamEvent) => {
    events.push(e)
    resolveNext?.()
  }

  const work = withUserLock(user.id, async () => {
    await syncJars(user)
    if ((await gdBalance(user.agentAddress)) < cost) {
      push({ t: 'error', message: `This costs G$ ${priceGd}. Your jars fill every day as Jara claims your G$.` })
      return
    }
    const reachable = await llmReachable()
    if (!reachable && serverConfig().chain.mode !== 'mock') {
      push({ t: 'error', message: 'Jara AI is offline for a moment. You were not charged. Try again soon.' })
      return
    }

    const now = Date.now()
    if (!chatId) {
      chatId = `c_${randomBytes(8).toString('hex')}`
      await run('INSERT INTO ai_chats (id, user_id, tool, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)', [chatId, user.id, tool, titleFrom(text), now, now])
    }
    await run('INSERT INTO ai_messages (chat_id, role, content, created_at) VALUES (?, ?, ?, ?)', [chatId, 'user', text, now])
    push({ t: 'chat', chatId, title: titleFrom(text), priceGd })

    if (!reachable) {
      // Demo build without an AI brain: show the layout, charge nothing.
      const demo = `# Demo preview\n\nJara AI isn't connected on this build, so this is a placeholder, not a real answer. You were not charged.\n\n**You asked:** ${text.slice(0, 200)}`
      push({ t: 'delta', v: demo })
      const r = await run('INSERT INTO ai_messages (chat_id, role, content, cost_gd, created_at) VALUES (?, ?, ?, 0, ?)', [chatId, 'assistant', demo, Date.now()])
      push({ t: 'done', messageId: Number(r.lastInsertRowid), costGd: 0, demo: true })
      return
    }

    const messages: ChatMessage[] = [
      { role: 'system', content: `${AI_BASE_PROMPT}\n\n${AI_TOOLS[tool].system}` },
      ...history.slice(-12).map((m) => ({ role: m.role, content: m.content }) as ChatMessage),
      { role: 'user', content: text },
    ]
    let answer = ''
    try {
      for await (const piece of chatStream(messages, isFollowUp ? 1600 : AI_TOOLS[tool].maxTokens)) {
        answer += piece
        push({ t: 'delta', v: piece })
      }
    } catch (err) {
      console.error('[ai-chat] stream failed', err)
    }
    answer = answer.trim()
    if (!answer) {
      push({ t: 'error', message: 'Jara AI didn’t answer. You were not charged.' })
      return
    }

    // Charge only now that a full answer exists.
    if (!(await debitJars(user, 'ai', cost))) {
      push({ t: 'error', message: 'Not enough G$.' })
      return
    }
    let hash: string | undefined
    try {
      hash = await sendGdFromAgent(decryptAgentKey(user.agentKeyEnc), treasuryAddress(), cost)
    } catch (err) {
      console.error('[ai-chat] G$ payment failed after answer', user.id, err)
    }
    const saved = await run('INSERT INTO ai_messages (chat_id, role, content, cost_gd, created_at) VALUES (?, ?, ?, ?, ?)', [chatId, 'assistant', answer, priceGd, Date.now()])
    await run('UPDATE ai_chats SET updated_at = ? WHERE id = ?', [Date.now(), chatId])
    await run('INSERT INTO ai_runs (user_id, tool, input, output, cost_gd, demo, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)', [user.id, tool, text, answer, priceGd, Date.now()])
    await logActivity(user.id, {
      type: 'ai',
      jar: 'ai',
      amountWei: cost.toString(),
      txHash: hash,
      title: `${AI_TOOLS[tool].name}: ${titleFrom(text)}`,
      detail: `Paid G$ ${Number(formatEther(cost)).toLocaleString()} from your AI jar`,
    })
    push({ t: 'done', messageId: Number(saved.lastInsertRowid), costGd: priceGd, demo: false })
  })
    .catch((err) => {
      console.error('[ai-chat] failed', err)
      push({ t: 'error', message: 'Something went wrong. You were not charged.' })
    })
    .finally(() => {
      finished = true
      resolveNext?.()
    })

  // Relay events as they are produced.
  for (;;) {
    if (events.length) {
      yield events.shift()!
      continue
    }
    if (finished) break
    await new Promise<void>((r) => (resolveNext = r))
    resolveNext = null
  }
  await work
}
