import { randomBytes } from 'node:crypto'
import {
  createPublicClient,
  createWalletClient,
  formatEther,
  http,
  parseAbi,
  parseEther,
  zeroAddress,
  type Address,
  type Hash,
} from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { celo } from 'viem/chains'
import { run } from './db'
import { serverConfig } from './env'

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
  'event UBIClaimed(address indexed account, uint256 amount)',
])
const erc20Abi = parseAbi([
  'function balanceOf(address account) view returns (uint256)',
  'function transfer(address to, uint256 amount) returns (bool)',
])
const faucetAbi = parseAbi(['function canTop(address _user) view returns (bool)', 'function topWallet(address _user)'])

export const CELOSCAN_TX = (hash: string) => `https://celoscan.io/tx/${hash}`

const isMock = () => serverConfig().chain.mode === 'mock'

function publicClient() {
  return createPublicClient({ chain: celo, transport: http(serverConfig().chain.rpcUrl) })
}

function walletFor(privateKey: `0x${string}`) {
  const account = privateKeyToAccount(privateKey)
  return createWalletClient({ account, chain: celo, transport: http(serverConfig().chain.rpcUrl) })
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

export async function gdBalance(address: Address): Promise<bigint> {
  if (isMock()) return mockBalance(address)
  return publicClient().readContract({ address: GD.token, abi: erc20Abi, functionName: 'balanceOf', args: [address] })
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

// ---------- writes ----------

/** Make sure an agent wallet can pay gas: GoodDollar faucet first, treasury CELO second. */
async function ensureGas(address: Address) {
  const pc = publicClient()
  const cfg = serverConfig().chain
  const bal = await pc.getBalance({ address })
  if (bal >= parseEther(cfg.minGasCelo)) return
  const treasury = walletFor(treasuryKey())
  try {
    const canTop = await pc.readContract({ address: GD.faucet, abi: faucetAbi, functionName: 'canTop', args: [address] })
    if (canTop) {
      const hash = await treasury.writeContract({ address: GD.faucet, abi: faucetAbi, functionName: 'topWallet', args: [address] })
      await pc.waitForTransactionReceipt({ hash })
      if ((await pc.getBalance({ address })) >= parseEther(cfg.minGasCelo)) return
    }
  } catch (err) {
    console.warn('[chain] faucet top-up failed, falling back to treasury', err)
  }
  const hash = await treasury.sendTransaction({ to: address, value: parseEther(cfg.gasTopUpCelo) })
  await pc.waitForTransactionReceipt({ hash })
}

/** Claim today's UBI with the user's connected agent wallet. Returns null if nothing to claim. */
export async function claimUbi(agentKey: `0x${string}`): Promise<{ amount: bigint; hash: Hash } | null> {
  const account = privateKeyToAccount(agentKey)
  if (isMock()) {
    const amount = parseEther(String(serverConfig().limits.mockDailyClaimGd))
    await mockAdd(account.address, amount)
    return { amount, hash: fakeHash() }
  }
  const pc = publicClient()
  const owed = await entitlement(account.address)
  if (owed === 0n) return null
  await ensureGas(account.address)
  const before = await gdBalance(account.address)
  const hash = await walletFor(agentKey).writeContract({ address: GD.ubi, abi: ubiAbi, functionName: 'claim' })
  const receipt = await pc.waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`Claim reverted: ${hash}`)
  const after = await gdBalance(account.address)
  return { amount: after > before ? after - before : owed, hash }
}

/** Send G$ from an agent wallet (e.g. to the treasury to pay a bill). */
export async function sendGdFromAgent(agentKey: `0x${string}`, to: Address, amount: bigint): Promise<Hash> {
  const account = privateKeyToAccount(agentKey)
  if (isMock()) {
    await mockAdd(account.address, -amount)
    await mockAdd(to, amount)
    return fakeHash()
  }
  await ensureGas(account.address)
  const hash = await walletFor(agentKey).writeContract({
    address: GD.token,
    abi: erc20Abi,
    functionName: 'transfer',
    args: [to, amount],
  })
  const receipt = await publicClient().waitForTransactionReceipt({ hash })
  if (receipt.status !== 'success') throw new Error(`G$ transfer reverted: ${hash}`)
  return hash
}

/** Send G$ from the treasury (rewards, refunds). */
export async function sendGdFromTreasury(to: Address, amount: bigint): Promise<Hash> {
  if (isMock()) {
    await mockAdd(to, amount)
    return fakeHash()
  }
  const hash = await walletFor(treasuryKey()).writeContract({
    address: GD.token,
    abi: erc20Abi,
    functionName: 'transfer',
    args: [to, amount],
  })
  await publicClient().waitForTransactionReceipt({ hash })
  return hash
}

/** Demo helper: simulate someone depositing G$ into a jar wallet. */
export async function mockDeposit(address: Address, amount: bigint) {
  if (!isMock()) throw new Error('mockDeposit is only available in CHAIN_MODE=mock')
  await mockAdd(address, amount)
}

export const formatGd = (wei: bigint, digits = 0) =>
  Number(formatEther(wei)).toLocaleString('en-US', { maximumFractionDigits: digits })
