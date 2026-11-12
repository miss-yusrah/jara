// Starts the background telemetry flush (app activity -> JaraTelemetry contract on Celo) every 10 minutes.
export async function register() {
  if (process.env.NEXT_RUNTIME !== 'nodejs' || process.env.NODE_ENV !== 'production') return
  const { flushTelemetry, telemetryConfig } = await import('./lib/telemetry')
  if (!telemetryConfig().enabled) return
  const tick = () => flushTelemetry().catch((err) => console.error('[telemetry] flush failed', err))
  setTimeout(tick, 30_000)
  setInterval(tick, 10 * 60_000).unref()
}
