import { createPublicClient, encodeFunctionData, getAddress, http, isAddress, isHex, parseAbi, parseEventLogs, zeroAddress, type Address } from 'viem'
import { celo } from 'viem/chains'
import { GD, entitlement, gdAllowance, verifyWalletSignature, whitelistedRoot } from './chain'
import { durableTransaction, hasSubmittedTransaction } from './chain-outbox'
import { serverConfig } from './env'
import { run } from './db'
import { getUserById, type User } from './users'
import { hasPendingFunds } from './account-lock'
import { bindWallet } from './wallet-authorization'
import { walletClaimerMessage } from './wallet-login'

export const claimerAbi = parseAbi([
  'function owner() view returns (address)',
  'function ubi() view returns (address)',
  'function gd() view returns (address)',
  'function claim() returns (uint256)',
  'event Claimed(address indexed owner, uint256 amount)',
])
export const claimerFactoryAbi = parseAbi([
  'function ubi() view returns (address)',
  'function gd() view returns (address)',
  'function claimerOf(address owner) view returns (address)',
  'function create(address owner) returns (address)',
])
const client = () => createPublicClient({ chain: celo, transport: http(serverConfig().chain.rpcUrl) })
const same = (a: string, b: string) => a.toLowerCase() === b.toLowerCase()
export function claimAddress(user: User): Address {
  if (!user.claimerActive) return user.agentAddress
  if (!user.claimerAddress) throw new Error('This account is missing its claim contract. Contact support; legacy claims will not be used.')
  return user.claimerAddress
}
export function rewardAddress(user: User): Address {
  if (!user.claimerActive) return user.agentAddress
  if (!user.rootAddress) throw new Error('This account is missing its owner wallet.')
  return user.rootAddress
}

/** A payout signed before migration must finish at its original address. */
export async function rewardDestination(user: User, operationId: string): Promise<Address> {
  const saved = (await run('SELECT intent FROM chain_transactions WHERE id = ?', [operationId])).rows[0]
  const destination = saved ? (JSON.parse(String(saved.intent)) as { transfer?: { to?: string } }).transfer?.to : null
  return destination && isAddress(destination) ? destination : rewardAddress(user)
}

/** Only read state here. Anyone can name a root during onboarding; that must not
 * let them spend the sponsor's gas deploying contracts before proving ownership. */
export async function prepareClaimer(user: User): Promise<User> {
  if (user.claimerActive) return user
  const configured = user.claimerFactory || serverConfig().chain.claimerFactory
  if (!configured || serverConfig().chain.mode !== 'celo') throw new Error('Keyless claims are not configured.')
  if (!isAddress(configured) || same(configured, zeroAddress)) throw new Error('Invalid claimer factory address.')
  if (!user.rootAddress) throw new Error('Connect your verified GoodDollar wallet first.')
  const factory = getAddress(configured)
  const rpc = client()
  const [ubi, gd, address] = await Promise.all([
    rpc.readContract({ address: factory, abi: claimerFactoryAbi, functionName: 'ubi' }),
    rpc.readContract({ address: factory, abi: claimerFactoryAbi, functionName: 'gd' }),
    rpc.readContract({ address: factory, abi: claimerFactoryAbi, functionName: 'claimerOf', args: [user.rootAddress] }),
  ])
  if (!same(ubi, GD.ubi) || !same(gd, GD.token) || same(address, zeroAddress)) throw new Error('The claimer factory does not match the configured GoodDollar contracts.')
  await run('UPDATE users SET claimer_address = ?, claimer_factory = ? WHERE id = ? AND claimer_active = 0', [address, factory, user.id])
  return (await getUserById(user.id))!
}

/** Migration is complete only after the owner linked the new contract AND revoked
 * the old agent's identity access. Keep the old key for balance recovery/export. */
export async function activateClaimer(input: User, proof?: { issuedAt?: number; signature?: string }): Promise<User> {
  if (input.claimerActive) return input
  const user = await prepareClaimer(input)
  if (!user.rootAddress || !user.claimerAddress || !user.claimerFactory) throw new Error('Prepare your claim contract first.')
  // A deterministic contract address is public, so its existing identity link is
  // NOT proof that the current browser owns it. Bind a fresh signature to this account.
  if (!proof || typeof proof.issuedAt !== 'number' || !Number.isFinite(proof.issuedAt) || Math.abs(Date.now() - proof.issuedAt) > 5 * 60_000 || !proof.signature || !isHex(proof.signature)) throw new Error('Approve the upgrade signature in your verified wallet. It expires after five minutes.')
  if (!await verifyWalletSignature(user.rootAddress, walletClaimerMessage(user.id, user.rootAddress, user.claimerAddress, proof.issuedAt), proof.signature)) throw new Error('The upgrade signature must come from your verified GoodDollar wallet for this Jara account.')
  const root = await whitelistedRoot(user.claimerAddress)
  if (!root || !same(root, user.rootAddress)) throw new Error('Link the new claim contract in your GoodDollar wallet first.')
  await bindWallet(user.id, user.rootAddress)
  if (user.agentKeyEnc !== 'keyless' && await whitelistedRoot(user.agentAddress)) {
    throw new Error('Unlink your old Jara wallet from your GoodDollar identity before completing the upgrade.')
  }
  if (await gdAllowance(user.rootAddress) > 0n) throw new Error('Revoke the old direct Jara spending allowance in your wallet before completing the upgrade.')
  const pendingClaim = (await run("SELECT 1 FROM chain_transactions WHERE sender = ? AND status = 'pending' LIMIT 1", [user.agentAddress.toLowerCase()])).rows.length > 0
  if (await hasPendingFunds(user.id, user.rootAddress) || pendingClaim) {
    throw new Error('A payment or claim is still pending. Let it finish before upgrading.')
  }
  const rpc = client()
  if (!await rpc.getCode({ address: user.claimerAddress })) {
    const key = serverConfig().chain.treasuryKey
    if (!key) throw new Error('Claim sponsorship is not configured.')
    await durableTransaction(`claimer:create:${user.claimerFactory.toLowerCase()}:${user.rootAddress.toLowerCase()}`, key, {
      to: user.claimerFactory, data: encodeFunctionData({ abi: claimerFactoryAbi, functionName: 'create', args: [user.rootAddress] }),
    })
  }
  const [owner, ubi, gd] = await Promise.all([
    rpc.readContract({ address: user.claimerAddress, abi: claimerAbi, functionName: 'owner' }),
    rpc.readContract({ address: user.claimerAddress, abi: claimerAbi, functionName: 'ubi' }),
    rpc.readContract({ address: user.claimerAddress, abi: claimerAbi, functionName: 'gd' }),
  ])
  if (!same(owner, user.rootAddress) || !same(ubi, GD.ubi) || !same(gd, GD.token)) throw new Error('Claim contract verification failed.')
  await run('UPDATE users SET claimer_active = 1, connected = 1 WHERE id = ?', [user.id])
  return (await getUserById(user.id))!
}

/** The server pays gas, but the immutable contract chooses the sole recipient.
 * Receipt events provide a stable amount when a timed-out request is retried. */
export async function claimViaContract(user: User, operationId: string) {
  if (!user.claimerActive || !user.claimerAddress || !user.rootAddress) throw new Error('Keyless claims are not active for this account.')
  if (!await hasSubmittedTransaction(operationId) && await entitlement(user.claimerAddress) === 0n) return null
  const key = serverConfig().chain.treasuryKey
  if (!key) throw new Error('Claim sponsorship is not configured.')
  // The outbox estimates actual gas; it does not use the old 500k gas-top-up budget.
  const result = await durableTransaction(operationId, key, { to: user.claimerAddress, data: encodeFunctionData({ abi: claimerAbi, functionName: 'claim' }) })
  const receipt = await client().getTransactionReceipt({ hash: result.hash })
  const amount = parseEventLogs({ abi: claimerAbi, eventName: 'Claimed', logs: receipt.logs })
    .filter((event) => same(event.address, user.claimerAddress!) && same(event.args.owner, user.rootAddress!))
    .reduce((sum, event) => sum + event.args.amount, 0n)
  return { ...result, amount }
}
