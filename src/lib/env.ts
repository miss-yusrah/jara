// Server-only configuration. Read lazily so `next build` works without secrets.

function num(name: string, fallback: number): number {
  const raw = process.env[name]
  if (raw === undefined || raw === '') return fallback
  const value = Number(raw)
  if (!Number.isFinite(value)) throw new Error(`${name} must be a number, got "${raw}"`)
  return value
}

export type ChainMode = 'celo' | 'mock'
export type ProviderName = 'falconpay' | 'vtpass' | 'mock'

/**
 * Which side of a bill payment is real money.
 *   demo      simulated G$ paying a simulated provider (mock, or a provider sandbox)
 *   live      real G$ on Celo paying a live provider
 *   bills-off real G$, no bill provider configured: bills are not offered
 *   mismatch  one side real and the other simulated. Never allowed: bills, demo
 *             top-ups and new provider purchases are all refused.
 */
export type MoneyMode = 'demo' | 'live' | 'bills-off' | 'mismatch'

const falconKeyLive = () => (process.env.FALCONPAY_API_KEY ?? '').startsWith('sk_live_')
const vtpassLive = () => process.env.VTPASS_ENV === 'live'

/** True when purchases through this provider spend Jara's real naira balance. */
export function providerIsLive(name: string): boolean {
  if (name === 'vtpass') return vtpassLive()
  if (name === 'falconpay') return falconKeyLive()
  return false
}

function resolveMoneyMode(chainMode: ChainMode, provider: ProviderName): { mode: MoneyMode; problem: string | null } {
  const realGd = chainMode === 'celo'
  const realProvider = providerIsLive(provider)
  if (realGd && realProvider) return { mode: 'live', problem: null }
  if (!realGd && !realProvider) return { mode: 'demo', problem: null }
  if (!realGd) {
    return { mode: 'mismatch', problem: `CHAIN_MODE=mock (simulated G$) cannot run with a live bill provider (TOPUP_PROVIDER=${provider}). Use the provider sandbox or TOPUP_PROVIDER=mock, or switch to CHAIN_MODE=celo.` }
  }
  // Real G$ with no provider at all is a valid launch state: bills are simply not offered.
  if (provider === 'mock' && process.env.DEMO_BILLS !== 'true') return { mode: 'bills-off', problem: null }
  return { mode: 'mismatch', problem: `CHAIN_MODE=celo (real G$) cannot run with a simulated bill provider (TOPUP_PROVIDER=${provider}${provider === 'mock' ? ' with DEMO_BILLS=true' : ' sandbox'}). Use live provider credentials, or TOPUP_PROVIDER=mock with DEMO_BILLS unset to switch bills off.` }
}

export function serverConfig() {
  const rawProvider = process.env.TOPUP_PROVIDER || 'mock'
  if (rawProvider !== 'vtpass' && rawProvider !== 'falconpay' && rawProvider !== 'mock') {
    throw new Error(`TOPUP_PROVIDER must be "falconpay", "vtpass" or "mock", got "${rawProvider}"`)
  }
  const provider: ProviderName = rawProvider
  if (process.env.CHAIN_MODE && !['celo', 'mock'].includes(process.env.CHAIN_MODE)) throw new Error('CHAIN_MODE must be celo or mock')
  const chainMode: ChainMode = process.env.CHAIN_MODE === 'celo' ? 'celo' : 'mock'
  if (process.env.NODE_ENV === 'production' && chainMode === 'mock' && process.env.ALLOW_MOCK_IN_PROD !== 'true') {
    // Allowed so a demo deploy can run, but say so loudly.
    console.warn('[jara] CHAIN_MODE=mock in production — balances are simulated')
  }
  const vtpassEnv = vtpassLive() ? 'live' : 'sandbox'
  const money = resolveMoneyMode(chainMode, provider)
  const rawCustody = process.env.WALLET_KEY_PROVIDER || 'local'
  if (rawCustody !== 'local' && rawCustody !== 'aws-kms') throw new Error(`WALLET_KEY_PROVIDER must be "aws-kms" or "local", got "${rawCustody}"`)
  const custodyProvider: 'local' | 'aws-kms' = rawCustody

  return {
    appUrl: (process.env.APP_URL || 'http://localhost:3400').replace(/\/$/, ''),
    chain: {
      mode: chainMode,
      rpcUrl: process.env.CELO_RPC_URL || 'https://forno.celo.org',
      // New accounts hold no agent key once the audited factory is configured.
      claimerFactory: process.env.CLAIMER_FACTORY_ADDRESS || '',
      spendingContract: process.env.SPENDING_CONTRACT_ADDRESS || '',
      // Treasury: receives G$ for bills, pays streak rewards, tops up agent gas.
      treasuryKey: (process.env.TREASURY_PRIVATE_KEY ?? '') as `0x${string}` | '',
      // Gas sent to an agent wallet when it runs low (in CELO).
      gasTopUpCelo: process.env.GAS_TOPUP_CELO || '0.02',
      minGasCelo: process.env.MIN_GAS_CELO || '0.005',
      // true = the treasury pays CELO gas for agent wallets when the GoodDollar faucet can't.
      // Off by default: the person adds CELO to their own Jara wallet.
      sponsorGas: process.env.SPONSOR_GAS === 'true',
      // Send G$ that lands in a Jara-managed wallet straight on to its owner's own wallet, so the
      // wallets Jara holds keys for stay empty. Applies once the owner spends from their own wallet.
      forwardClaims: process.env.FORWARD_CLAIMS !== 'false',
      // Below this many G$ a forward is not worth its network fee; it waits for the next one.
      forwardMinGd: num('FORWARD_MIN_GD', 20),
    },
    // Server-held key (64 hex chars). Wraps wallet data keys only with WALLET_KEY_PROVIDER=local,
    // and reads wallet keys stored before per-wallet encryption until they are migrated.
    walletSecret: process.env.WALLET_ENCRYPTION_KEY ?? '',
    custody: {
      // Where the key that wraps each wallet's own data key lives: see lib/custody.ts.
      provider: custodyProvider,
      kms: {
        keyId: process.env.WALLET_KMS_KEY_ID ?? '',
        region: process.env.WALLET_KMS_REGION ?? '',
        accessKeyId: process.env.WALLET_KMS_ACCESS_KEY_ID ?? '',
        secretAccessKey: process.env.WALLET_KMS_SECRET_ACCESS_KEY ?? '',
      },
    },
    pricing: {
      // Fixed G$→NGN rate override. Empty = live CoinGecko price.
      fixedNgnPerGd: num('GD_NGN_RATE', 0),
      spreadBps: num('PRICE_SPREAD_BPS', 200),
    },
    rewards: {
      referralBudgetGd: num('REFERRAL_CAMPAIGN_BUDGET_GD', 10_000),
      referralDailyGd: num('REFERRAL_DAILY_BUDGET_GD', 2_000),
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
    provider,
    /** Real and simulated money never mix: see MoneyMode. */
    moneyMode: money.mode,
    /** Why the configuration is refused, when moneyMode is "mismatch". */
    moneyProblem: money.problem,
    // Bills run only when both sides match: real G$ with a live provider, or simulated G$
    // with a simulated provider (the mock provider additionally needs the local demo flag).
    billsLive: money.mode === 'live' || (money.mode === 'demo' && (provider !== 'mock' || process.env.DEMO_BILLS === 'true')),
    falconpay: {
      apiKey: process.env.FALCONPAY_API_KEY ?? '',
      // sk_live_ keys go to production, everything else to the sandbox.
      live: falconKeyLive(),
      baseUrl: falconKeyLive() ? 'https://payment.falconpay.ng/v1' : 'https://sandbox.falconpay.ng/v1',
      webhookSecret: process.env.FALCONPAY_WEBHOOK_SECRET ?? '',
    },
    vtpass: {
      env: vtpassEnv,
      baseUrl: vtpassEnv === 'live' ? 'https://vtpass.com/api' : 'https://sandbox.vtpass.com/api',
      apiKey: process.env.VTPASS_API_KEY ?? '',
      publicKey: process.env.VTPASS_PUBLIC_KEY ?? '',
      secretKey: process.env.VTPASS_SECRET_KEY ?? '',
    },
    db: {
      url: process.env.DATABASE_URL || (chainMode === 'celo' ? 'file:data/jara.db' : 'file:data/jara-demo.db'),
      authToken: process.env.DATABASE_AUTH_TOKEN || undefined,
    },
    cronSecret: process.env.CRON_SECRET ?? '',
  }
}

/** Test phone numbers are only accepted when no real money can move. */
export function testNumbersAllowed(): boolean {
  const cfg = serverConfig()
  if (cfg.provider === 'mock') return true
  if (cfg.provider === 'vtpass') return cfg.vtpass.env === 'sandbox'
  return !cfg.falconpay.live
}

export function isDemoMode(): boolean {
  const cfg = serverConfig()
  return cfg.chain.mode === 'mock' || cfg.provider === 'mock'
}

/**
 * Checked again at the moment a purchase is sent to `providerName`, including purchases
 * resumed after a restart or a configuration change. Returns why it must not be sent, or null.
 */
export function billPurchaseProblem(providerName: string): string | null {
  const cfg = serverConfig()
  if (cfg.moneyProblem) return cfg.moneyProblem
  const realGd = cfg.chain.mode === 'celo'
  if (realGd !== providerIsLive(providerName)) {
    return realGd ? `Real G$ cannot pay the simulated "${providerName}" provider.` : `Simulated G$ cannot pay the live "${providerName}" provider.`
  }
  return cfg.billsLive ? null : 'Bill payments are switched off.'
}

/** Demo top-ups mint simulated G$; they exist only when nothing real can be bought with it. */
export function demoFundsAllowed(): boolean {
  return serverConfig().moneyMode === 'demo'
}

/** Fail before accepting traffic; purchase boundaries still enforce mode independently. */
export function assertSafeRuntime() {
  const cfg = serverConfig()
  if (cfg.moneyProblem) throw new Error(cfg.moneyProblem)
  if (cfg.chain.mode === 'mock' && (falconKeyLive() || (vtpassLive() && cfg.vtpass.apiKey) || cfg.chain.treasuryKey || process.env.TELEMETRY_REPORTER_KEY)) {
    throw new Error('Demo deployments must not contain live provider or treasury signing credentials.')
  }
  if (cfg.chain.mode === 'celo' && cfg.custody.provider === 'local' && !/^[0-9a-f]{64}$/i.test(cfg.walletSecret)) {
    throw new Error('Live money requires WALLET_ENCRYPTION_KEY to be 64 hex chars, regardless of NODE_ENV.')
  }
  for (const value of [cfg.rewards.referralBudgetGd, cfg.rewards.referralDailyGd]) {
    if (!Number.isSafeInteger(value) || value < 0) throw new Error('Referral budgets must be nonnegative safe integers in G$.')
  }
}
