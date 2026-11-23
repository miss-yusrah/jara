import type { NextRequest } from 'next/server'
import { serverConfig } from './env'

/**
 * True when a browser request comes from Jara's own pages. Behind the
 * production proxy `req.nextUrl.origin` is the internal address
 * (http://localhost:…), never what the browser sends as Origin, so compare
 * against the public app URL and the forwarded host instead. A cross-site page
 * can't fake its Origin, and callers also require a custom header that a
 * cross-site form can't send.
 */
export function fromThisSite(req: NextRequest): boolean {
  const origin = req.headers.get('origin')
  if (!origin) return true
  const allowed = new Set<string>([req.nextUrl.origin])
  try { allowed.add(new URL(serverConfig().appUrl).origin) } catch { /* unset in tests */ }
  const proto = req.headers.get('x-forwarded-proto')?.split(',')[0]?.trim() || 'https'
  for (const host of [req.headers.get('x-forwarded-host'), req.headers.get('host')]) {
    const h = host?.split(',')[0]?.trim()
    if (h) { allowed.add(`${proto}://${h}`); allowed.add(`https://${h}`) }
  }
  return allowed.has(origin)
}
