import { scheduleAutoPay } from '@/lib/auto-pay-after'
import { timingSafeEqual } from 'node:crypto'
import { NextResponse } from 'next/server'
import { handleMessage, resolvePending } from '@/lib/agent'
import { run } from '@/lib/db'
import { serverConfig } from '@/lib/env'
import { CONFIRM_KEYBOARD, answerCallback, editKeyboard, sendMessage, sendTyping } from '@/lib/telegram'
import { createUser, consumeLinkCode, getUserByTelegram, linkTelegram } from '@/lib/users'

export const dynamic = 'force-dynamic'

type TelegramChat = { id: number; type?: string }
type TelegramSender = { id: number; is_bot?: boolean; first_name?: string }

interface Update {
  message?: { message_id: number; chat: TelegramChat; from?: TelegramSender; text?: string; voice?: unknown }
  callback_query?: { id: string; from?: TelegramSender; data?: string; message?: { chat: TelegramChat; message_id: number } }
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

function privateOwner(chat: TelegramChat | undefined, sender: TelegramSender | undefined): boolean {
  return chat?.type === 'private' && Number.isSafeInteger(chat.id) && chat.id > 0 && sender?.id === chat.id && sender.is_bot !== true
}

async function handle(update: Update) {
  const appUrl = serverConfig().appUrl

  if (update.callback_query) {
    const cb = update.callback_query
    if (!privateOwner(cb.message?.chat, cb.from)) return
    if (!/^(confirm|cancel):[a-zA-Z0-9-]+$/.test(cb.data ?? '')) {
      await answerCallback(cb.id)
      return
    }
    const chatId = String(cb.message?.chat.id ?? '')
    const user = await getUserByTelegram(chatId)
    await answerCallback(cb.id)
    if (!user || !cb.message) return
    await editKeyboard(chatId, cb.message.message_id)
    await sendTyping(chatId)
    const reply = await resolvePending(user.id, cb.data?.startsWith('confirm:') ?? false, cb.data?.split(':')[1])
    scheduleAutoPay(user.id)
    await run('INSERT INTO messages (user_id, role, content, created_at) VALUES (?, ?, ?, ?)', [user.id, 'assistant', reply.text, Date.now()])
    await sendMessage(chatId, reply.text + (reply.explorerUrl ? `\n\nReceipt: ${reply.explorerUrl}` : ''))
    // e.g. the first exam drill that an approved request produced.
    for (const extra of reply.extra ?? []) {
      await run('INSERT INTO messages (user_id, role, content, created_at) VALUES (?, ?, ?, ?)', [user.id, 'assistant', extra, Date.now()])
      await sendMessage(chatId, extra)
    }
    return
  }

  const msg = update.message
  if (!msg || !privateOwner(msg.chat, msg.from)) return
  const chatId = String(msg.chat.id)
  const text = msg.text?.trim() ?? ''

  if (text.startsWith('/start')) {
    const code = text.split(/\s+/)[1]
    const linked = code ? await consumeLinkCode(code) : null
    if (linked) {
      await linkTelegram(linked.id, chatId)
      await sendMessage(chatId, `You're linked${linked.name ? `, ${linked.name}` : ''} 🙌 I'll message you here every morning after I claim your G$.\n\nTry: "How much is in my jars?"`)
      return
    }
    const existing = await getUserByTelegram(chatId)
    if (existing?.connected) {
      await sendMessage(chatId, `Welcome back${existing.name ? `, ${existing.name}` : ''} 👋 You're all set. Ask me anything, e.g. "How much is in my jars?"`, [
        [{ text: 'Open Jara on the web', url: `${appUrl}/app?tg=${existing.linkCode}` }],
      ])
      return
    }
    const user = existing ?? (await createUser({ name: msg.from?.first_name, tgChatId: chatId }))
    await sendMessage(
      chatId,
      `Hi${msg.from?.first_name ? ` ${msg.from.first_name}` : ''}! I'm Jara, your AI agent.\n\nEvery day I collect your GoodDollar and put it to work: I save it in jars, pay your airtime, data and light, find you G$ rewards, and pay for AI help with research, assignments and exams.\n\nNew to Jara? Tap "Set up Jara" to connect your GoodDollar account (about 3 minutes).\n\nAlready using Jara on the website? Don't set up again. Open usejara.xyz/app, tap "Also use Telegram" in Getting started (or "Add Telegram" by the agent log), and I'll link to your existing account.`,
      [
        [{ text: 'Set up Jara', url: `${appUrl}/app?tg=${user.linkCode}` }],
        [{ text: 'I already use Jara on the web', url: `${appUrl}/app` }],
      ],
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
  const reply = await handleMessage(user.id, text, `telegram:${chatId}:${msg.message_id}`)
  scheduleAutoPay(user.id)
  await sendMessage(chatId, reply.text, reply.confirm ? CONFIRM_KEYBOARD(reply.confirm.id, reply.confirm.action) : undefined)
  for (const m of reply.extra ?? []) await sendMessage(chatId, m)
}
