// Logs the money mode at startup, and starts the background telemetry flush (app activity -> JaraTelemetry contract on Celo) every 10 minutes.
export async function register() {
  // Keep Node-only database imports out of the Edge instrumentation bundle.
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    const { serverConfig, assertSafeRuntime } = await import('./lib/env')
    assertSafeRuntime()
    const { db } = await import('./lib/db')
    await db()
    const cfg = serverConfig()
    if (cfg.moneyProblem) console.error(`[jara] UNSAFE CONFIGURATION, bill payments and demo top-ups are disabled: ${cfg.moneyProblem}`)
    else console.info(`[jara] money mode: ${cfg.moneyMode} (CHAIN_MODE=${cfg.chain.mode}, TOPUP_PROVIDER=${cfg.provider}, bills ${cfg.billsLive ? 'on' : 'off'})`)
    if (cfg.chain.mode === 'celo' && cfg.custody.provider === 'local') {
      console.warn('[jara] WALLET_KEY_PROVIDER=local: the key that unwraps agent wallet keys is stored on this server. Set WALLET_KEY_PROVIDER=aws-kms for production.')
    }
    if (process.env.NODE_ENV !== 'production') return
    const { flushTelemetry, telemetryConfig } = await import('./lib/telemetry')
    if (!telemetryConfig().enabled) return
    const tick = () => flushTelemetry().catch((err) => console.error('[telemetry] flush failed', err))
    setTimeout(tick, 30_000)
    setInterval(tick, 10 * 60_000).unref()
  }
}
