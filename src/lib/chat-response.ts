import { ApiError, readApiResponse, responseMessage } from './api-response'

type ChatEvent =
  | { t: 'chat'; chatId: string }
  | { t: 'delta'; v: string }
  | { t: 'done'; messageId: number; costGd: number }
  | { t: 'error'; message: string; terminal?: boolean }

const interrupted = () => new ApiError('The answer was interrupted before confirmation. Retry to check the same request.', 'interrupted_stream', 0, true)

function event(line: string): ChatEvent {
  let value: unknown
  try { value = JSON.parse(line) } catch { throw interrupted() }
  if (!value || typeof value !== 'object') throw interrupted()
  const e = value as Record<string, unknown>
  if (e.t === 'chat' && typeof e.chatId === 'string' && e.chatId) return { t: 'chat', chatId: e.chatId }
  if (e.t === 'delta' && typeof e.v === 'string') return { t: 'delta', v: e.v }
  if (e.t === 'done' && Number.isSafeInteger(e.messageId) && Number(e.messageId) > 0 && typeof e.costGd === 'number' && Number.isFinite(e.costGd) && e.costGd >= 0) return { t: 'done', messageId: Number(e.messageId), costGd: e.costGd }
  if (e.t === 'error' && typeof e.message === 'string') return { t: 'error', message: responseMessage(e.message), terminal: e.terminal === true }
  throw interrupted()
}

/** Chunk boundaries can split JSON or UTF-8. Only a validated terminal event
 * confirms a result; EOF or malformed data must retain the payment identity.
 */
export async function* readChatEvents(response: Response): AsyncGenerator<ChatEvent> {
  if (!response.ok) await readApiResponse(response)
  if (!response.body || !response.headers.get('content-type')?.includes('application/x-ndjson')) throw interrupted()
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      const { done, value } = await reader.read()
      buffer += done ? decoder.decode() : decoder.decode(value, { stream: true })
      let newline: number
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline)
        buffer = buffer.slice(newline + 1)
        if (!line.trim()) continue
        const next = event(line)
        yield next
        // Never undo a confirmed result because the connection later fails.
        if (next.t === 'done' || next.t === 'error') return
      }
      if (done) {
        if (buffer.trim()) {
          const last = event(buffer)
          yield last
          if (last.t === 'done' || last.t === 'error') return
        }
        throw interrupted()
      }
    }
  } catch (err) {
    if (err instanceof ApiError) throw err
    throw interrupted()
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}
