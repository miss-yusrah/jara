import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { handleMessage, resolvePending } from '@/lib/agent'
import { run } from '@/lib/db'
import { serverConfig } from '@/lib/env'
import { CONFIRM_KEYBOARD, answerCallback, editKeyboard, sendMessage, sendTyping } from '@/lib/telegram'
import { createUser, getUserByLinkCode, getUserByTelegram, linkTelegram, rotateLinkCode } from '@/lib/users'

export const dynamic = 'force-dynamic'

interface Update {
  message?: { chat: { id: number }; from?: { first_name?: string }; text?: string; voice?: unknown }
  callback_query?: { id: string; data?: string; message?: { chat: { id: number }; message_id: number } }
}

export async function POST(req: Request) {
  // Fail closed: without a configured secret, anyone could post fake updates as any chat.
  const { webhookSecret } = serverConfig().telegram
  const got = Buffer.from(req.headers.get('x-telegram-bot-api-secret-token') ?? '')
  const want = Buffer.from(webhookSecret)
  if (!webhookSecret || got.length !== want.length || !timingSafeEqual(got, want)) {
    return NextResponse.json({ ok: false }, { status: 401 })
  }
  const update = (await req.json()) as Update
  try {
    await handle(update)
  } catch (err) {
    console.error('[telegram] update failed', err)
  }
  return NextResponse.json({ ok: true })
}

async function handle(update: Update) {
  const appUrl = serverConfig().appUrl

  if (update.callback_query) {
    const cb = update.callback_query
    const chatId = String(cb.message?.chat.id ?? '')
    const user = await getUserByTelegram(chatId)
    await answerCallback(cb.id)
    if (!user || !cb.message) return
    await editKeyboard(chatId, cb.message.message_id)
    await sendTyping(chatId)
    const reply = await resolvePending(user.id, cb.data === 'confirm')
    await run('INSERT INTO messages (user_id, role, content, created_at) VALUES (?, ?, ?, ?)', [user.id, 'assistant', reply.text, Date.now()])
    await sendMessage(chatId, reply.text + (reply.explorerUrl ? `\n\nReceipt: ${reply.explorerUrl}` : ''))
    return
  }

  const msg = update.message
  if (!msg) return
  const chatId = String(msg.chat.id)
  const text = msg.text?.trim() ?? ''

  if (text.startsWith('/start')) {
    const code = text.split(/\s+/)[1]
    const linked = code ? await getUserByLinkCode(code) : null
    if (linked) {
      await linkTelegram(linked.id, chatId)
      await rotateLinkCode(linked.id)
      await sendMessage(chatId, `You're linked${linked.name ? `, ${linked.name}` : ''} 🙌 I'll message you here every morning after I claim your G$.\n\nTry: "How much is in my jars?"`)
      return
    }
    let user = await getUserByTelegram(chatId)
    user ??= await createUser({ name: msg.from?.first_name, tgChatId: chatId })
    await sendMessage(
      chatId,
      `Hi${msg.from?.first_name ? ` ${msg.from.first_name}` : ''}! I'm Jara, your AI agent.\n\nEvery day I collect your GoodDollar and put it to work: I save it in jars, pay your airtime, data and light, find you G$ rewards, and pay for AI help with research, assignments and ideas.\n\nFirst, connect your GoodDollar account (takes 1 minute):`,
      [[{ text: 'Set up Jara', url: `${appUrl}/app?tg=${user.linkCode}` }]],
    )
    return
  }

  const user = await getUserByTelegram(chatId)
  if (!user) {
    await sendMessage(chatId, 'Send /start to begin.')
    return
  }
  if (msg.voice) {
    await sendMessage(chatId, "Voice notes are coming soon 🎙️ For now, type it — e.g. \"₦500 airtime for my mama 0803…\"")
    return
  }
  if (!text) return
  await sendTyping(chatId)
  const reply = await handleMessage(user.id, text)
  await sendMessage(chatId, reply.text, reply.confirm ? CONFIRM_KEYBOARD : undefined)
}
