// Server-only configuration. Read lazily so `next build` works without secrets.

function num(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number, got "${raw}"`)
  return value
}

export type ChainMode = 'celo' | 'mock'

export function serverConfig() {
  const provider = process.env.TOPUP_PROVIDER || 'mock'
  if (provider !== 'vtpass' && provider !== 'mock') {
    throw new Error(`TOPUP_PROVIDER must be "vtpass" or "mock", got "${provider}"`)
  }
  const chainMode: ChainMode = process.env.CHAIN_MODE === 'celo' ? 'celo' : 'mock'
  if (process.env.NODE_ENV === 'production' && chainMode === 'mock' && process.env.ALLOW_MOCK_IN_PROD !== 'true') {
    // Allowed so a demo deploy can run, but say so loudly.
    console.warn('[jara] CHAIN_MODE=mock in production — balances are simulated')
  }
  const vtpassEnv = process.env.VTPASS_ENV === 'live' ? 'live' : 'sandbox'

  return {
    appUrl: (process.env.APP_URL || 'http://localhost:3400').replace(/\/$/, ''),
    chain: {
      mode: chainMode,
      rpcUrl: process.env.CELO_RPC_URL || 'https://forno.celo.org',
      // Treasury: receives G$ for bills, pays streak rewards, tops up agent gas.
      treasuryKey: (process.env.TREASURY_PRIVATE_KEY ?? '') as `0x${string}` | '',
      // Gas sent to an agent wallet when it runs low (in CELO).
      gasTopUpCelo: process.env.GAS_TOPUP_CELO || '0.02',
      minGasCelo: process.env.MIN_GAS_CELO || '0.005',
    },
    // AES key (64 hex chars) that encrypts per-user agent wallet keys at rest.
    walletSecret: process.env.WALLET_ENCRYPTION_KEY ?? '',
    pricing: {
      // Fixed G$→NGN rate override. Empty = live CoinGecko price.
      fixedNgnPerGd: num('GD_NGN_RATE', 0),
      spreadBps: num('PRICE_SPREAD_BPS', 200),
    },
    rewards: {
      streakDays: num('STREAK_REWARD_DAYS', 7),
      streakRewardGd: num('STREAK_REWARD_GD', 500),
    },
    limits: {
      maxBillNgn: num('MAX_BILL_NGN', 20_000),
      mockDailyClaimGd: num('MOCK_DAILY_CLAIM_GD', 1400),
    },
    llm: {
      // Defaults to the AntSeed buyer proxy (OpenAI-compatible, pays per call in USDC on Base).
      baseUrl: (process.env.LLM_BASE_URL || 'http://localhost:8377/v1').replace(/\/$/, ''),
      apiKey: process.env.LLM_API_KEY || 'antseed',
      model: process.env.LLM_MODEL || 'deepseek-v4-flash',
      antseedPeer: process.env.ANTSEED_PIN_PEER || '',
      disabled: process.env.LLM_DISABLED === 'true',
      dailyCallCap: Number(process.env.LLM_DAILY_CALL_CAP) || 3000,
    },
    telegram: {
      botToken: process.env.TELEGRAM_BOT_TOKEN ?? '',
      botUsername: process.env.TELEGRAM_BOT_USERNAME ?? '',
      webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET ?? '',
    },
    provider: provider as 'vtpass' | 'mock',
    vtpass: {
      env: vtpassEnv,
      baseUrl: vtpassEnv === 'live' ? 'https://vtpass.com/api' : 'https://sandbox.vtpass.com/api',
      apiKey: process.env.VTPASS_API_KEY ?? '',
      publicKey: process.env.VTPASS_PUBLIC_KEY ?? '',
      secretKey: process.env.VTPASS_SECRET_KEY ?? '',
    },
    db: {
      url: process.env.DATABASE_URL || 'file:data/jara.db',
      authToken: process.env.DATABASE_AUTH_TOKEN || undefined,
    },
    cronSecret: process.env.CRON_SECRET ?? '',
  }
}

export function isDemoMode(): boolean {
  const cfg = serverConfig()
  return cfg.chain.mode === 'mock' || cfg.provider === 'mock'
}
