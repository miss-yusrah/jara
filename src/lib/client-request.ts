// Retain the request ID across network retries and reloads. A confirmed result
// clears it; a lost response never creates a second payment identity.
const memory = new Map<string, string>()
export function clientRequest(scope: string, input: unknown) {
  const key = `jara:pending:${scope}:${JSON.stringify(input)}`
  let id = memory.get(key)
  try { id ??= window.sessionStorage.getItem(key) ?? undefined } catch { /* private browsing */ }
  id ??= crypto.randomUUID()
  memory.set(key, id)
  try { window.sessionStorage.setItem(key, id) } catch { /* in-memory fallback */ }
  return {
    id,
    finish() {
      memory.delete(key)
      try { window.sessionStorage.removeItem(key) } catch { /* in-memory fallback */ }
    },
  }
}
