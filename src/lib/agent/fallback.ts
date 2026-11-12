// Rule-based understanding used when no LLM is reachable. Covers the core
// phrases (English + common Pidgin) so the agent never goes silent.

export type Intent =
  | { type: 'bill'; kind: 'airtime' | 'data' | 'light'; amountNgn?: number; phone?: string; plan?: string; network?: string }
  | { type: 'balance' }
  | { type: 'claim' }
  | { type: 'move'; jar: 'airtime' | 'data' | 'light'; amountNgn: number }
  | { type: 'ai' }
  | { type: 'rewards' }
  | { type: 'run' }
  | { type: 'help' }

/** Only complete, unambiguous requests bypass the model. Never infer consent
 * from a mention of airtime, a conditional, or a negated instruction. */
export function directIntent(raw: string): Intent | null {
  const text = raw.trim().replace(/[’]/g, "'")
  if (/^(?:my balance|balance|check my balance|what(?:'s| is) in my jars|my jars|wetin dey my jars)[?!.]*$/i.test(text)) return { type: 'balance' }
  if (/^(?:my rewards|show my rewards|rewards)[?!.]*$/i.test(text)) return { type: 'rewards' }
  const match = text.match(/^(?:please\s+)?(?:(?:buy|send|recharge|pay(?:\s+for)?)\s+)?(?:₦|ngn\s*|n)?([\d,]+(?:\.\d+)?)\s*(k)?\s+(?:(mtn|airtel|glo|9mobile)\s+)?airtime(?:\s+(?:for\s+me|(?:to|for)\s+((?:\+?234|0)[\d\s-]{9,15})))?[.!]?$/i)
  if (!match) return null
  const value = Number(match[1].replace(/,/g, '')) * (match[2] ? 1000 : 1)
  if (!Number.isFinite(value) || value < 50) return null
  return { type: 'bill', kind: 'airtime', amountNgn: value, network: match[3]?.toLowerCase(), phone: match[4]?.trim() }
}

function amount(text: string): number | undefined {
  const m = text.replace(/,/g, '').match(/(?:₦|n|ngn\s?)?(\d+(?:\.\d+)?)\s*(k)?\b(?!\s*(?:gb|mb))/i)
  if (!m) return undefined
  const n = Number(m[1]) * (m[2] ? 1000 : 1)
  return n >= 50 ? n : undefined
}

function phone(text: string): string | undefined {
  const m = text.replace(/[\s-]/g, '').match(/(\+?234|0)[789][01]\d{8}/)
  return m?.[0]
}

export function fallbackIntent(raw: string): Intent {
  const text = raw.toLowerCase()
  const textNoPhone = text.replace(/(\+?234|0)[789][01][\d\s-]{8,11}/g, ' ')
  const plan = text.match(/(\d+(?:\.\d+)?)\s*(gb|mb)/)

  if (/\b(move|put|add)\b.*\b(jar)\b/.test(text)) {
    const jar = /light|nepa|electric/.test(text) ? 'light' : /data/.test(text) ? 'data' : 'airtime'
    const a = amount(textNoPhone)
    if (a) return { type: 'move', jar, amountNgn: a }
  }
  if (/\b(light|nepa|electric|electricity|meter|units?|prepaid)\b/.test(text)) {
    return { type: 'bill', kind: 'light', amountNgn: amount(textNoPhone) }
  }
  if (plan || /\bdata\b|\bmb\b|\bgb\b|bundle/.test(text)) {
    return { type: 'bill', kind: 'data', amountNgn: amount(textNoPhone) ?? 20_000, phone: phone(text), plan: plan ? `${plan[1]}${plan[2]}` : undefined }
  }
  if (/\b(airtime|recharge|credit|card|top ?up|vtu)\b/.test(text)) {
    return { type: 'bill', kind: 'airtime', amountNgn: amount(textNoPhone), phone: phone(text) }
  }
  if (/\b(research|assignment|homework|essay|project|brainstorm|ideas?|exam|jamb|waec|neco|cv|resume|cover letter|scholarships?|internships?|caption|study|ai)\b/.test(text)) return { type: 'ai' }
  if (/\b(reward|rewards|bonus|bonuses|cashback)\b/.test(text)) return { type: 'rewards' }
  if (/\b(check in|run|do your thing|handle (it|everything))\b/.test(text)) return { type: 'run' }
  if (/\b(claim|collect|ubi)\b/.test(text)) return { type: 'claim' }
  if (/\b(balance|jar|jars|how much|wetin dey|remain|left|saved?)\b/.test(text)) return { type: 'balance' }
  return { type: 'help' }
}
