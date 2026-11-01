// Small in-memory fixed-window limiter. Jara runs as one Node process (pm2 fork
// mode), so this is enough; move to the database if it ever runs on several.

const buckets = new Map<string, { count: number; resetAt: number }>()

/** Returns true if the action is allowed, false once `limit` is used up for this window. */
export function rateLimit(key: string, limit: number, windowMs: number): boolean {
  const now = Date.now()
  const b = buckets.get(key)
  if (!b || b.resetAt <= now) {
    buckets.set(key, { count: 1, resetAt: now + windowMs })
    if (buckets.size > 50_000) for (const [k, v] of buckets) if (v.resetAt <= now) buckets.delete(k)
    return true
  }
  if (b.count >= limit) return false
  b.count++
  return true
}

/** Client IP as set by nginx (the app itself only listens on 127.0.0.1). */
export function clientIp(req: Request): string {
  return req.headers.get('x-real-ip') ?? req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ?? 'local'
}
