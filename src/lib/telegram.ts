import { serverConfig } from './env'

// Thin Telegram Bot API client (webhook mode).

type Keyboard = { text: string; callback_data?: string; url?: string }[][]

async function call(method: string, body: Record<string, unknown>) {
  const token = serverConfig().telegram.botToken
  if (!token) return null
  const res = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  })
  const json = (await res.json()) as { ok: boolean; description?: string; result?: unknown }
  if (!json.ok) console.warn(`[telegram] ${method} failed: ${json.description}`)
  return json.result
}

export function telegramEnabled() {
  return Boolean(serverConfig().telegram.botToken)
}

export function sendMessage(chatId: string, text: string, keyboard?: Keyboard) {
  return call('sendMessage', {
    chat_id: chatId,
    text,
    disable_web_page_preview: true,
    ...(keyboard ? { reply_markup: { inline_keyboard: keyboard } } : {}),
  })
}

export function answerCallback(id: string, text?: string) {
  return call('answerCallbackQuery', { callback_query_id: id, text })
}

export function editKeyboard(chatId: string, messageId: number) {
  return call('editMessageReplyMarkup', { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } })
}

export function sendTyping(chatId: string) {
  return call('sendChatAction', { chat_id: chatId, action: 'typing' })
}

export function botLink(linkCode?: string) {
  const name = serverConfig().telegram.botUsername
  if (!name) return null
  return `https://t.me/${name}${linkCode ? `?start=${linkCode}` : ''}`
}

export const CONFIRM_KEYBOARD = (id: string): Keyboard => [
  [
    { text: '✅ Pay it', callback_data: `confirm:${id}` },
    { text: '✖ Cancel', callback_data: `cancel:${id}` },
  ],
]
