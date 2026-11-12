// A proxy can return HTML, an empty body, or a truncated response. None of those
// tells us whether a payment succeeded, so preserve the original request ID.
export class ApiError extends Error {
  constructor(message: string, readonly code?: string, readonly status = 0, readonly retryable = false, readonly terminal = false) { super(message) }
}

export function responseMessage(error: unknown, fallback = 'The connection was interrupted. Please retry the same request.'): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : ''
  if (!message || /SyntaxError|Unexpected (?:token|end)|JSON\.parse|(?:invalid|valid|parse|parsing).*JSON|JSON.*(?:position|parse|unexpected)|<!doctype|<html|Failed to fetch|fetch failed|Load failed|NetworkError/i.test(message)) return fallback
  return message
}

export async function readApiResponse<T>(response: Response): Promise<T> {
  let data: unknown
  try { data = await response.json() } catch {
    throw new ApiError('Jara could not confirm the response. If this was a payment, retry this same request to check it.', 'invalid_response', response.status, true)
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new ApiError('Jara returned an incomplete response. Please retry the same request.', 'invalid_response', response.status, true)
  }
  const result = data as Record<string, unknown>
  if (!response.ok) {
    const message = responseMessage(typeof result.error === 'string' ? result.error.trim() : '', 'Jara is temporarily unavailable. Please retry the same request.')
    throw new ApiError(message, typeof result.code === 'string' ? result.code : undefined, response.status,
      result.retryable === true || [408, 429, 500, 502, 503, 504].includes(response.status), result.terminal === true)
  }
  return data as T
}
