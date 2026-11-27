import { randomBytes } from 'node:crypto'
import {
  createPublicClient,
  encodeFunctionData,
  parseEventLogs,
  formatEther,
  http,
  parseAbi,
  parseEther,
  zeroAddress,
  keccak256,
  toBytes,
  isAddress,
  type Address,
  type Hash,
  type Hex,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { celo } from 'viem/chains'
import { atomic, run } from './db'
import { durableTransaction, hasSubmittedTransaction } from './chain-outbox'
import { serverConfig } from './env'
import { spendingPolicyAbi } from './spending-policy'
import { retryBlockRead } from './chain-read'

// GoodDollar production contracts on Celo, as listed in @goodsdks/citizen-sdk constants.
export const GD = {
  token: '0x62B8B11039FcfE5aB0C56E502b1C372A3d2a9c7A',
  identity: '0xC361A6E67822a0EDc17D899227dd9FC50BD62F42',
  ubi: '0x43d72Ff17701B2DA814620735C39C620Ce0ea4A1',
  faucet: '0x4F93Fa058b03953C851eFaA2e4FC5C34afDFAb84',
} as const satisfies Record<string, Address>

export const identityAbi = parseAbi([
  'function getWhitelistedRoot(address account) view returns (address)',
  'function connectAccount(address account) external',
])
const ubiAbi = parseAbi([
  'function claim() returns (bool)',
  'function checkEntitlement(address _member) view returns (uint256)',
  'function periodStart() view returns (uint256)',
  'event UBIClaimed(address indexed account, uint256 amount)',
])
const erc20Abi = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
  'event Transfer(address indexed from, address indexed to, uint256 value)',
  'function allowance(address owner, address spender) view returns (uint256)',
  'function transferFrom(address from, address to, uint256 amount) returns (bool)',
])
const faucetAbi = parseAbi(['function canTop(address _user) view returns (bool)', 'function topWallet(address _user)'])

export const CELOSCAN_TX = (hash: string) => `https://celoscan.io/tx/${hash}`

const isMock = () => serverConfig().chain.mode === 'mock'

function publicClient() {
  return createPublicClient({ chain: celo, transport: http(serverConfig().chain.rpcUrl) })
}


function treasuryKey(): `0x${string}` {
  const k = serverConfig().chain.treasuryKey
  if (!k) throw new Error('TREASURY_PRIVATE_KEY is not set')
  return k
}

export function treasuryAddress(): Address {
  if (isMock()) return '0x000000000000000000000000000000000000dEaD'
  return privateKeyToAccount(treasuryKey()).address
}

// ---------- mock ledger (CHAIN_MODE=mock) ----------

async function mockBalance(address: string): Promise<bigint> {
  const r = await run('SELECT wei FROM mock_balances WHERE address = ?', [address.toLowerCase()])
  return r.rows[0] ? BigInt(r.rows[0].wei as string) : 0n
}

async function mockAdd(address: string, delta: bigint) {
  const next = (await mockBalance(address)) + delta
  if (next < 0n) throw new Error('Insufficient G$ balance')
  await run(
    'INSERT INTO mock_balances (address, wei) VALUES (?, ?) ON CONFLICT (address) DO UPDATE SET wei = excluded.wei',
    [address.toLowerCase(), next.toString()],
  )
}

const fakeHash = () => `0x${randomBytes(32).toString('hex')}` as Hash

// ---------- reads ----------

export async function balanceBlock(): Promise<bigint | undefined> {
  return isMock() ? undefined : publicClient().getBlockNumber({ cacheTime: 0 })
}

export async function gdBalance(address: Address, blockNumber?: bigint): Promise<bigint> {
  if (isMock()) return mockBalance(address)
  return retryBlockRead(() => publicClient().readContract({ address: GD.token, abi: erc20Abi, functionName: 'balanceOf', args: [address], blockNumber }))
}

/** The verified GoodDollar identity an address belongs to, or null. */
export async function whitelistedRoot(address: Address): Promise<Address | null> {
  if (isMock()) return null
  const root = await publicClient().readContract({
    address: GD.identity,
    abi: identityAbi,
    functionName: 'getWhitelistedRoot',
    args: [address],
  })
  return root === zeroAddress ? null : root
}

/** G$ the identity behind `address` can claim right now (0 if already claimed today). */
export async function entitlement(address: Address): Promise<bigint> {
  if (isMock()) return parseEther(String(serverConfig().limits.mockDailyClaimGd))
  const root = (await whitelistedRoot(address)) ?? address
  return publicClient().readContract({ address: GD.ubi, abi: ubiAbi, functionName: 'checkEntitlement', args: [root] })
}

/** GoodDollar's 24-hour claim periods start at periodStart, not local midnight.
 * Use the latest chain timestamp so a stored currentDay awaiting the next claim
 * cannot keep us in the old period. Read both values against the same block. */
export async function ubiClaimPeriod() {
  const rpc = publicClient()
  const block = await rpc.getBlock()
  if (block.number === null) throw new Error('The claim period block is not confirmed.')
  const start = await retryBlockRead(() => rpc.readContract({ address: GD.ubi, abi: ubiAbi, functionName: 'periodStart', blockNumber: block.number! }))
  if (start > block.timestamp) throw new Error('GoodDollar claims have not started yet.')
  const index = (block.timestamp - start) / 86_400n
  const startsAt = start + index * 86_400n
  return { id: `ubi-${start}-${index}`, startsAt: Number(startsAt) * 1000, endsAt: Number(startsAt + 86_400n) * 1000 }
}

const identityExpiryAbi = parseAbi([
  'function lastAuthenticated(address account) view returns (uint256)',
  'function authenticationPeriod() view returns (uint256)',
  'function reverifyDaysOptions(uint256) view returns (uint32)',
  'function identities(address) view returns (uint256 dateAuthenticated, uint256 dateAdded, string did, uint256 whitelistedOnChainId, uint8 status, uint8 authCount)',
])

/** When the user's GoodDollar face verification expires (ms), or null if unknown. Claims stop after this. */
export async function verificationExpiresAt(root: Address): Promise<number | null> {
  if (isMock()) return null
  const pc = publicClient()
  const [last, period, identity] = await Promise.all([
    pc.readContract({ address: GD.identity, abi: identityExpiryAbi, functionName: 'lastAuthenticated', args: [root] }),
    pc.readContract({ address: GD.identity, abi: identityExpiryAbi, functionName: 'authenticationPeriod' }),
    pc.readContract({ address: GD.identity, abi: identityExpiryAbi, functionName: 'identities', args: [root] }),
  ])
  if (last === 0n) return null
  // IdentityV4 shortens early windows: a first face check must be redone after
  // reverifyDaysOptions[0] (3) days, then [1] (180). Past the list it uses the period.
  const authCount = BigInt(identity[5])
  const days = await pc
    .readContract({ address: GD.identity, abi: identityExpiryAbi, functionName: 'reverifyDaysOptions', args: [authCount] })
    .then((d) => BigInt(d), () => period)
  return Number(last + days * 86_400n) * 1000
}

/** True if `signature` over `message` was made by `address`. Also handles smart-contract wallets (ERC-1271). */
export async function verifyWalletSignature(address: Address, message: string, signature: `0x${string}`): Promise<boolean> {
  return publicClient().verifyMessage({ address, message, signature }).catch(() => false)
}

// ---------- writes ----------

export const GAS_LOW_MESSAGE =
  'Your Jara wallet needs a little CELO for the network fee. Open your profile (top right) and tap “Add gas”. Nothing was spent.'

/** Thrown when a Jara wallet can't pay the Celo network fee and nobody is sponsoring it. */
export class GasLowError extends Error {
  constructor(readonly needCelo: number, readonly haveCelo: number) {
    super(`Your Jara wallet needs about ${needCelo.toFixed(2)} CELO for the network fee (it has ${haveCelo.toFixed(3)}).`)
    this.name = 'GasLowError'
  }
}

let feeCache: { perGas: bigint; at: number } | null = null

/** Live Celo fee per gas unit, cached for a minute. */
async function feePerGas(): Promise<bigint> {
  if (feeCache && Date.now() - feeCache.at < 60_000) return feeCache.perGas
  const fees = await publicClient().estimateFeesPerGas()
  const perGas = fees.maxFeePerGas ?? fees.gasPrice ?? 0n
  feeCache = { perGas, at: Date.now() }
  return perGas
}

const TX_GAS = 400_000n // covers a UBI claim (~350k) or a G$ transfer (~215k)

/** CELO a Jara wallet holds, and roughly what one transaction costs right now. */
export async function gasStatus(address: Address): Promise<{ celo: number; perTxCelo: number }> {
  if (isMock()) return { celo: 1, perTxCelo: 0.01 }
  const [bal, perGas] = await Promise.all([publicClient().getBalance({ address }), feePerGas()])
  return { celo: Number(formatEther(bal)), perTxCelo: Number(formatEther(TX_GAS * perGas)) }
}

/**
 * Make sure an agent wallet can pay for one transaction at today's Celo fees.
 * Order: the wallet's own CELO → GoodDollar's free gas faucet → the treasury, when
 * `sponsor` is set (the person repays the fee in G$) or SPONSOR_GAS=true. Otherwise
 * throws GasLowError so the person can add CELO.
 */
async function ensureGas(address: Address, opts: { sponsor?: boolean; gasUnits?: bigint; operationId: string }) {
  const gasUnits = opts.gasUnits ?? TX_GAS
  if (isMock()) return
  const pc = publicClient()
  const cfg = serverConfig().chain
  const live = (gasUnits * (await feePerGas()) * 3n) / 2n // 1.5x headroom for fee spikes
  const floor = parseEther(cfg.minGasCelo)
  const needed = live > floor ? live : floor
  if ((await pc.getBalance({ address })) >= needed) return
  try {
    const canTop = await pc.readContract({ address: GD.faucet, abi: faucetAbi, functionName: 'canTop', args: [address] })
    if (canTop && cfg.treasuryKey) {
      // The faucet pays the CELO; we only pay the gas for asking it.
      await durableTransaction(`faucet:${opts.operationId}`, treasuryKey(), { to: GD.faucet, data: encodeFunctionData({ abi: faucetAbi, functionName: 'topWallet', args: [address] }) })
      if ((await pc.getBalance({ address })) >= needed) return
    }
  } catch (err) {
    if (await hasSubmittedTransaction(`faucet:${opts.operationId}`)) {
      const saved = (await run('SELECT status FROM chain_transactions WHERE id = ?', [`faucet:${opts.operationId}`])).rows[0]
      if (saved?.status === 'pending') throw err
    }
    console.warn('[chain] faucet top-up failed', err)
  }
  const current = await pc.getBalance({ address })
  if (!cfg.sponsorGas && !opts.sponsor) throw new GasLowError(Number(formatEther(needed)), Number(formatEther(current)))
  const want = needed * 2n - current
  const minTop = parseEther(cfg.gasTopUpCelo)
  const id = `gas:${opts.operationId}`
  const saved = (await run('SELECT intent FROM chain_transactions WHERE id = ?', [id])).rows[0]
  const value = saved ? BigInt(JSON.parse(String(saved.intent)).value) : want > minTop ? want : minTop
  await durableTransaction(id, treasuryKey(), { to: address, value })
}

/**
 * Ask GoodDollar's free gas faucet to top up a person's own verified wallet (the faucet pays
 * the CELO; Jara only pays the tiny fee for asking). Lets a brand-new Google-login wallet
 * approve setup without buying CELO. Best effort: returns whether it now has enough.
 */
export async function topUpFromFaucet(address: Address): Promise<boolean> {
  if (isMock() || !serverConfig().chain.treasuryKey) return false
  const pc = publicClient()
  const needed = (TX_GAS * (await feePerGas()) * 3n) / 2n
  if ((await pc.getBalance({ address })) >= needed) return true
  const canTop = await pc.readContract({ address: GD.faucet, abi: faucetAbi, functionName: 'canTop', args: [address] })
  if (!canTop) return false
  const day = new Date().toISOString().slice(0, 10)
  await durableTransaction(`faucet:root:${address.toLowerCase()}:${day}`, treasuryKey(), {
    to: GD.faucet,
    data: encodeFunctionData({ abi: faucetAbi, functionName: 'topWallet', args: [address] }),
  })
  return (await pc.getBalance({ address })) >= needed
}

/** Most CELO Jara sends for one sponsored call. A council vote (~310k gas)
 * needs ~0.15 CELO up front at ~240 gwei and spends ~0.06 of it. */
export const SPONSORED_CALL_CAP = parseEther('0.25')

/**
 * Jara pays for one specific transaction the person must send from their own
 * wallet (a council vote can't be relayed: it counts msg.sender). Estimates that
 * exact call, then tops the wallet up to cover it: GoodDollar's free faucet first,
 * the treasury for the rest. The treasury transfer is durable under
 * `gas:<operationId>`, so a retried request never pays twice.
 * Returns false when the wallet already had enough.
 */
export async function sponsorWalletCall(address: Address, call: { to: Address; data: Hex }, operationId: string): Promise<boolean> {
  if (isMock()) return false
  if (!serverConfig().chain.treasuryKey) throw new Error('Jara can’t cover network fees on this deployment.')
  const pc = publicClient()
  const [gas, perGas] = await Promise.all([pc.estimateGas({ account: address, to: call.to, data: call.data }), feePerGas()])
  // Wallets require gasLimit × maxFee up front and set gasLimit ~1.5× the
  // estimate, so cover 2×. Any unspent CELO stays in the person's wallet.
  const needed = gas * perGas * 2n
  const enough = async () => (await pc.getBalance({ address })) >= needed
  if (await enough()) return false
  const id = `gas:${operationId}`
  const saved = (await run('SELECT intent FROM chain_transactions WHERE id = ?', [id])).rows[0]
  if (!saved) {
    try {
      if (await pc.readContract({ address: GD.faucet, abi: faucetAbi, functionName: 'canTop', args: [address] })) {
        await durableTransaction(`faucet:${operationId}`, treasuryKey(), { to: GD.faucet, data: encodeFunctionData({ abi: faucetAbi, functionName: 'topWallet', args: [address] }) })
        if (await enough()) return true
      }
    } catch (err) {
      const pending = (await run("SELECT 1 FROM chain_transactions WHERE id = ? AND status = 'pending'", [`faucet:${operationId}`])).rows[0]
      if (pending) throw err
      console.warn('[chain] faucet top-up failed', err instanceof Error ? err.name : 'error')
    }
  }
  const balance = await pc.getBalance({ address })
  if (!saved && balance >= needed) return true
  const value = saved ? BigInt(JSON.parse(String(saved.intent)).value) : needed - balance
  if (value > SPONSORED_CALL_CAP) throw new Error('Celo network fees are unusually high right now. Please try again later.')
  await durableTransaction(id, treasuryKey(), { to: address, value })
  return true
}

/** True if the agent wallet can pay for a transaction (topping up from the faucet if possible). */
export async function canPayGas(address: Address): Promise<boolean> {
  if (isMock()) return true
  const needed = (TX_GAS * (await feePerGas()) * 3n) / 2n
  return (await publicClient().getBalance({ address })) >= needed
}

/** Claim today's UBI with the user's connected agent wallet. Returns null if nothing to claim. */
export async function claimUbi(
  agentKey: `0x${string}`,
  opts: { sponsor?: boolean; operationId: string },
): Promise<{ amount: bigint; hash: Hash; feeWei: bigint } | null> {
  const account = privateKeyToAccount(agentKey)
  const id = opts.operationId
  if (isMock()) {
    const amount = parseEther(String(serverConfig().limits.mockDailyClaimGd))
    const hash = await mockTransfer(id, null, account.address, amount)
    return { amount, hash, feeWei: 0n }
  }
  const submitted = await hasSubmittedTransaction(id)
  if (!submitted && (await entitlement(account.address)) === 0n) return null
  if (!submitted) await ensureGas(account.address, opts)
  const r = await durableTransaction(id, agentKey, { to: GD.ubi, data: encodeFunctionData({ abi: ubiAbi, functionName: 'claim' }) })
  // Receipt logs are stable across retries; balance deltas are not.
  const receipt = await publicClient().getTransactionReceipt({ hash: r.hash })
  const amount = parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: receipt.logs })
    .filter((l) => l.address.toLowerCase() === GD.token.toLowerCase() && l.args.to.toLowerCase() === account.address.toLowerCase())
    .reduce((sum, l) => sum + l.args.value, 0n)
  return { ...r, amount }

}

/** Send G$ from an agent wallet. Returns the CELO fee it cost, so it can be charged back in G$. */
export async function transferFromAgent(
  agentKey: `0x${string}`,
  to: Address,
  amount: bigint,
  opts: { sponsor?: boolean; operationId: string },
): Promise<{ hash: Hash; feeWei: bigint }> {
  const account = privateKeyToAccount(agentKey)
  if (isMock()) return { hash: await mockTransfer(opts.operationId, account.address, to, amount), feeWei: 0n }
  if (!(await hasSubmittedTransaction(opts.operationId))) await ensureGas(account.address, opts)
  return durableTransaction(opts.operationId, agentKey, { to: GD.token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, amount] }), transfer: { token: GD.token, from: account.address, to, amount: String(amount) } })
}


/** How much G$ the treasury may still pull from `owner`'s own wallet (their spending limit). */
export async function gdAllowance(owner: Address, blockNumber?: bigint, policy = false): Promise<bigint> {
  if (isMock()) return 0n
  if (policy) {
    const address = serverConfig().chain.spendingContract
    // Claims continue without a payment policy; spending is disabled, never falls
    // back to a direct treasury allowance when configuration is absent.
    if (!address) return 0n
    await verifySpendingContract()
    return retryBlockRead(() => publicClient().readContract({ address: address as Address, abi: spendingPolicyAbi, functionName: 'available', args: [owner], blockNumber }))
  }
  return retryBlockRead(() => publicClient().readContract({ address: GD.token, abi: erc20Abi, functionName: 'allowance', args: [owner, treasuryAddress()], blockNumber }))
}

/** The whole limit left under a spending policy, ignoring how much of it today allows. */
export async function policyTotalLeft(owner: Address): Promise<bigint> {
  if (isMock()) return 0n
  const address = serverConfig().chain.spendingContract
  if (!address) return 0n
  const [[remaining, , validUntil], allowance] = await Promise.all([
    retryBlockRead(() => publicClient().readContract({ address: address as Address, abi: spendingPolicyAbi, functionName: 'policies', args: [owner] })),
    retryBlockRead(() => publicClient().readContract({ address: GD.token, abi: erc20Abi, functionName: 'allowance', args: [owner, address as Address] })),
  ])
  if (BigInt(Math.floor(Date.now() / 1000)) >= validUntil) return 0n
  return remaining < allowance ? remaining : allowance
}

/** Pull G$ from the person's own wallet into the treasury, within the limit they approved. */
export async function pullGdFromWallet(from: Address, amount: bigint, operationId: string, policy = false): Promise<{ hash: Hash; feeWei: bigint }> {
  if (isMock()) throw new Error('Spending from your own wallet is not available in demo mode')
  if (policy) {
    const address = await verifySpendingContract()
    return durableTransaction(operationId, treasuryKey(), { to: address, data: encodeFunctionData({ abi: spendingPolicyAbi, functionName: 'charge', args: [from, amount, keccak256(toBytes(operationId))] }), transfer: { token: GD.token, from, to: treasuryAddress(), amount: String(amount) } })
  }
  return durableTransaction(operationId, treasuryKey(), { to: GD.token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transferFrom', args: [from, treasuryAddress(), amount] }), transfer: { token: GD.token, from, to: treasuryAddress(), amount: String(amount) } })
}

export async function verifySpendingContract(): Promise<Address> {
  const address = serverConfig().chain.spendingContract
  if (!isAddress(address) || address === zeroAddress) throw new Error('Protected spending is not configured. Your claims still go to your wallet.')
  const pc = publicClient()
  const [token, operator, recipient] = await Promise.all([
    pc.readContract({ address, abi: spendingPolicyAbi, functionName: 'gd' }),
    pc.readContract({ address, abi: spendingPolicyAbi, functionName: 'operator' }),
    pc.readContract({ address, abi: spendingPolicyAbi, functionName: 'recipient' }),
  ])
  if (token.toLowerCase() !== GD.token.toLowerCase() || operator.toLowerCase() !== treasuryAddress().toLowerCase() || recipient.toLowerCase() !== treasuryAddress().toLowerCase()) throw new Error('Spending contract configuration does not match this deployment.')
  return address
}

// ---------- referral rewards ----------
// Referral rewards are paid from the one Jara treasury, like every other payout.

export function referralWalletConfigured(): boolean {
  return isMock() || Boolean(serverConfig().chain.treasuryKey)
}

export function referralWalletAddress(): Address | null {
  return referralWalletConfigured() ? treasuryAddress() : null
}

/** Pay a referral reward from the treasury. Durable under `operationId`: a retry never pays twice. */
export async function sendGdFromReferralWallet(to: Address, amount: bigint, operationId: string): Promise<Hash> {
  return sendGdFromTreasury(to, amount, operationId)
}

/** The treasury's G$ and CELO, for the referral admin view. */
export async function referralWalletBalances(): Promise<{ address: Address; gd: number; celo: number } | null> {
  const address = referralWalletAddress()
  if (!address || isMock()) return null
  const [gd, celoWei] = await Promise.all([gdBalance(address), publicClient().getBalance({ address })])
  return { address, gd: Number(formatEther(gd)), celo: Number(formatEther(celoWei)) }
}

/** Rewards and refunds must reuse their durable operation ID on every retry. */
export async function sendGdFromTreasury(to: Address, amount: bigint, operationId: string): Promise<Hash> {
  if (isMock()) return mockTransfer(operationId, null, to, amount)
  return (await durableTransaction(operationId, treasuryKey(), { to: GD.token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, amount] }), transfer: { token: GD.token, from: treasuryAddress(), to, amount: String(amount) } })).hash
}

/**
 * Jara Streak pays from the one Jara treasury, like every other payout. Sends from one wallet
 * are signed one at a time, so sharing it with claims and rewards never clashes.
 */
export function streakWalletAddress(): Address {
  if (isMock()) return '0x000000000000000000000000000000000000c0de'
  return treasuryAddress()
}
export async function sendGdFromStreakWallet(to: Address, amount: bigint, operationId: string): Promise<Hash> {
  if (isMock()) return mockTransfer(operationId, null, to, amount)
  const key = treasuryKey()
  const from = treasuryAddress()
  return (await durableTransaction(operationId, key, { to: GD.token, data: encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, amount] }), transfer: { token: GD.token, from, to, amount: String(amount) } })).hash
}

/** G$ that transaction `hash` sent to `to` (0 if none). Waits for it to be mined. */
export async function gdReceivedIn(hash: Hash, to: Address): Promise<bigint> {
  const receipt = await publicClient().waitForTransactionReceipt({ hash, timeout: 60_000 })
  if (receipt.status !== 'success') return 0n
  const logs = parseEventLogs({ abi: erc20Abi, eventName: 'Transfer', logs: receipt.logs })
  return logs
    .filter((l) => l.address.toLowerCase() === GD.token.toLowerCase() && l.args.to.toLowerCase() === to.toLowerCase())
    .reduce((sum, l) => sum + l.args.value, 0n)
}

/** Demo helper: simulate someone depositing G$ into a jar wallet. */
export async function mockDeposit(address: Address, amount: bigint) {
  if (!isMock()) throw new Error('mockDeposit is only available in CHAIN_MODE=mock')
  await mockAdd(address, amount)
}

export const formatGd = (wei: bigint, digits = 0) =>
  Number(formatEther(wei)).toLocaleString('en-US', { maximumFractionDigits: digits })

/** Demo transfers have the same replay guarantees as on-chain transfers. */
async function mockTransfer(id: string, from: Address | null, to: Address, amount: bigint): Promise<Hash> {
  return atomic(async (tx) => {
    const intent = JSON.stringify({ from, to, amount: String(amount) })
    const saved = (await tx.execute({ sql: 'SELECT * FROM chain_transactions WHERE id = ?', args: [id] })).rows[0]
    if (saved) {
      if (saved.intent !== intent) throw new Error('Transaction intent mismatch')
      return saved.hash as Hash
    }
    for (const [address, delta] of [[from, -amount], [to, amount]] as const) {
      if (!address) continue
      const row = (await tx.execute({ sql: 'SELECT wei FROM mock_balances WHERE address = ?', args: [address.toLowerCase()] })).rows[0]
      const next = BigInt(String(row?.wei ?? '0')) + delta
      if (next < 0n) throw new Error('Insufficient G$ balance')
      await tx.execute({ sql: 'INSERT INTO mock_balances(address, wei) VALUES (?, ?) ON CONFLICT(address) DO UPDATE SET wei = excluded.wei', args: [address.toLowerCase(), String(next)] })
    }
    const hash = fakeHash()
    await tx.execute({ sql: "INSERT INTO chain_transactions(id, sender, intent, raw, hash, status, created_at) VALUES (?, ?, ?, '', ?, 'confirmed', ?)", args: [id, from?.toLowerCase() ?? 'mock-treasury', intent, hash, Date.now()] })
    return hash
  })
}
