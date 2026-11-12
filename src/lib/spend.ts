import { formatEther, type Address } from 'viem'
import {
  GasLowError,
  balanceBlock,
  gdAllowance,
  gdBalance,
  pullGdFromWallet,
  sendGdFromTreasury,
  transferFromAgent,
  treasuryAddress,
} from './chain'
import { atomic, run } from './db'
import { withMoneyLock } from './money-lock'
import { authorizedUser } from './wallet-authorization'
import { hasSubmittedTransaction, TransferPendingError, TransferRevertedError } from './chain-outbox'
import { moneyRequest } from './money-request'
import type { JarKind } from './users'
import { serverConfig } from './env'
import { getUserById, type User } from './users'
import type { Row } from '@libsql/client'
import { decryptAgentKey } from './wallets'

// Where Jara's G$ comes from.
//
// "wallet" mode (the person approved a spending limit): G$ stays in their own wallet.
//   Each purchase uses one wallet only. Claimed G$ stays in the agent wallet until
//   spent or explicitly withdrawn. Jara covers new payment network fees.
// "jar" mode (older setup, no limit): everything is spent from the Jara wallet, which needs
//   its own CELO for fees.

export type SpendMode = 'wallet' | 'jar'

/** Spending limit people approve at setup (and each time they raise it). */
export const DEFAULT_LIMIT_GD = 5000

export class PaymentFailedError extends Error {
  constructor(detail = 'The transfer failed.') {
    super(`${detail} No G$ was transferred for this payment. You can start a new request.`)
  }
}

export interface SpendingPower {
  mode: SpendMode
  /** G$ in the Jara wallet (claims, old deposits). */
  agentWei: bigint
  /** Network fees owed back to Jara, in G$. */
  owedWei: bigint
  /** Jara-wallet G$ after fees owed. */
  agentAvailWei: bigint
  /** G$ in the person's own wallet (0 if unknown). */
  walletWei: bigint
  /** How much more Jara may pull from their wallet. */
  allowanceWei: bigint
  /** What Jara can actually pull right now: min(wallet, limit). */
  pullableWei: bigint
  /** Everything Jara can spend for them. */
  totalWei: bigint
}

const min = (a: bigint, b: bigint) => (a < b ? a : b)
const pos = (a: bigint) => (a > 0n ? a : 0n)

export async function getGasOwed(userId: string): Promise<bigint> {
  const r = await run('SELECT gas_owed_wei FROM users WHERE id = ?', [userId])
  return BigInt(String(r.rows[0]?.gas_owed_wei ?? '0'))
}

export async function spendMode(user: User): Promise<SpendMode> {
  if (!user.rootAddress || serverConfig().chain.mode === 'mock') return 'jar'
  return (await gdAllowance(user.rootAddress)) > 0n ? 'wallet' : 'jar'
}

export async function spendingPower(user: User): Promise<SpendingPower> {
  const root = user.rootAddress
  const useWallet = Boolean(root) && serverConfig().chain.mode !== 'mock'
  // A withdrawal moves tokens between these addresses. Read both at one block
  // so funds cannot appear in both wallets during that transfer.
  const block = await balanceBlock()
  const [agentWei, owedWei, walletWei, allowanceWei] = await Promise.all([
    gdBalance(user.agentAddress, block),
    getGasOwed(user.id),
    useWallet ? gdBalance(root!, block) : Promise.resolve(0n),
    useWallet ? gdAllowance(root!, block) : Promise.resolve(0n),
  ])
  const mode: SpendMode = allowanceWei > 0n ? 'wallet' : 'jar'
  const agentAvailWei = pos(agentWei - owedWei)
  const pullableWei = mode === 'wallet' ? min(walletWei, allowanceWei) : 0n
  // Fees the Jara wallet can't cover come out of what we can pull.
  const owedFromWallet = pos(owedWei - agentWei)
  const totalWei = mode === 'wallet' ? agentAvailWei + pos(pullableWei - owedFromWallet) : agentAvailWei
  return { mode, agentWei, owedWei, agentAvailWei, walletWei, allowanceWei, pullableWei, totalWei }
}

/** Everything Jara can spend for this person right now (wei). */
export async function spendableWei(user: User): Promise<bigint> {
  return (await spendingPower(user)).totalWei
}

/**
 * One durable payment, one funding wallet. The jar reservation and payment row
 * commit together. Unknown chain outcomes stay reserved until the SAME ID resumes.
 */
export async function spendGd(input: User, amount: bigint, request: { id: string; jar: JarKind }): Promise<{ hash: string }> {
  return withMoneyLock(`user:${input.id}`, async () => {
    if (amount <= 0n) throw new Error('Payment amount must be positive.')
    let payment = (await run('SELECT * FROM payments WHERE id = ?', [request.id])).rows[0]
    if (payment && (payment.user_id !== input.id || payment.jar !== request.jar || payment.amount_wei !== String(amount))) throw new Error('Payment request does not match its original amount or owner.')
    if (payment?.status === 'paid') return { hash: String(payment.tx_hash) }
    if (payment?.status === 'failed') throw new PaymentFailedError()
    if (payment && payment.status !== 'reserved') throw new Error(`This payment is ${payment.status}. It cannot be charged again.`)
    const txId = `charge:${request.id}`
    // Fulfil an already-authorized, signed charge even if the identity link was
    // subsequently revoked. Replays use the saved destination and signed bytes.
    let user: User
    const submitted = payment ? await hasSubmittedTransaction(txId) : false
    if (submitted) user = (await getUserById(input.id))!
    else {
      try { user = await authorizedUser(input) }
      catch (err) {
        if (payment) await releaseReservation(payment)
        throw new PaymentFailedError(err instanceof Error ? err.message : 'Wallet authorization failed.')
      }
    }
    if (!payment) {
      const pending = await run("SELECT 1 FROM payments WHERE user_id = ? AND status IN ('reserved', 'refunding')", [user.id])
      if (pending.rows.length) throw new TransferPendingError()
      const p = await spendingPower(user)
      // Never split a purchase between the agent wallet and the user's wallet.
      const owedFromWallet = pos(p.owedWei - p.agentWei)
      const source = p.agentAvailWei >= amount ? 'jar' : pos(p.pullableWei - owedFromWallet) >= amount ? 'wallet' : null
      if (!source) throw new Error('One wallet must cover this purchase after reserving outstanding fees. Move funds explicitly or choose a smaller amount.')
      // Network fees Jara fronted (shown on each claim) are repaid inside this same transfer.
      const fees = source === 'jar' ? min(p.owedWei, p.agentWei - amount) : min(p.owedWei, pos(p.pullableWei - amount))
      await atomic(async (tx) => {
        const all = (await tx.execute({ sql: 'SELECT kind, balance_wei FROM jars WHERE user_id = ?', args: [user.id] })).rows
        const balance = BigInt(String(all.find((r) => r.kind === request.jar)?.balance_wei ?? '0'))
        // A bill can be bigger than its jar's target: cover the gap from G$ not budgeted
        // to any jar. Other jars are never touched.
        const unassigned = pos(p.totalWei - all.reduce((s, r) => s + BigInt(String(r.balance_wei)), 0n))
        if (balance + unassigned < amount) {
          throw new Error(`Not enough G$ in your ${request.jar} jar (and nothing unbudgeted to top it up). Move money into it first; other jars are protected.`)
        }
        await tx.execute({ sql: 'UPDATE jars SET balance_wei = ? WHERE user_id = ? AND kind = ?', args: [String(pos(balance - amount)), user.id, request.jar] })
        await tx.execute({ sql: 'INSERT INTO payments(id, user_id, jar, amount_wei, source, refund_address, fees_wei, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)', args: [request.id, user.id, request.jar, String(amount), source, source === 'jar' ? user.agentAddress : user.rootAddress!, String(fees), Date.now()] })
      })
      payment = (await run('SELECT * FROM payments WHERE id = ?', [request.id])).rows[0]
    }
    const collectedFees = BigInt(String(payment.fees_wei))
    let result: { hash: string; feeWei: bigint }
    try {
      result = payment.source === 'wallet'
        ? await pullGdFromWallet(payment.refund_address as Address, amount + collectedFees, txId)
        : await transferFromAgent(decryptAgentKey(user.agentKeyEnc), treasuryAddress(), amount + collectedFees, { sponsor: true, operationId: txId })
    } catch (err) {
      // A timeout is NOT evidence that no money moved.
      if (err instanceof TransferRevertedError || !(await hasSubmittedTransaction(txId))) {
        await releaseReservation(payment)
        throw new PaymentFailedError(err instanceof Error ? err.message : 'The transfer failed.')
      }
      throw err
    }
    // The fees repaid in this transfer come off what's owed.
    await atomic(async (tx) => {
      const row = (await tx.execute({ sql: 'SELECT gas_owed_wei FROM users WHERE id = ?', args: [user.id] })).rows[0]
      await tx.execute({ sql: 'UPDATE users SET gas_owed_wei = ? WHERE id = ?', args: [String(pos(BigInt(String(row.gas_owed_wei ?? '0')) - collectedFees)), user.id] })
      await tx.execute({ sql: "UPDATE payments SET status = 'paid', tx_hash = ? WHERE id = ?", args: [result.hash, request.id] })
    })
    return { hash: result.hash }
  })
}

async function releaseReservation(payment: Row) {
  await atomic(async (tx) => {
    const claimed = await tx.execute({ sql: "UPDATE payments SET status = 'failed' WHERE id = ? AND status = 'reserved'", args: [payment.id] })
    if (!claimed.rowsAffected) return
    const jar = (await tx.execute({ sql: 'SELECT balance_wei FROM jars WHERE user_id = ? AND kind = ?', args: [payment.user_id, payment.jar] })).rows[0]
    await tx.execute({ sql: 'UPDATE jars SET balance_wei = ? WHERE user_id = ? AND kind = ?', args: [String(BigInt(String(jar.balance_wei)) + BigInt(String(payment.amount_wei))), payment.user_id, payment.jar] })
  })
}

/** A failed service refunds the original funding wallet, with one durable transfer. */
export async function refundPayment(user: User, id: string): Promise<string> {
  return withMoneyLock(`user:${user.id}`, async () => {
    const p = (await run('SELECT * FROM payments WHERE id = ? AND user_id = ?', [id, user.id])).rows[0]
    if (!p) throw new Error('Payment record not found.')
    if (p.status === 'refunded') return String(p.refund_hash)
    if (p.status !== 'paid' && p.status !== 'refunding') throw new Error('Payment has not been confirmed; no refund can be sent yet.')
    await run("UPDATE payments SET status = 'refunding' WHERE id = ?", [id])
    const hash = await sendGdFromTreasury(p.refund_address as Address, BigInt(String(p.amount_wei)), `refund:${id}`)
    const available = await spendableWei(user)
    await atomic(async (tx) => {
      const all = (await tx.execute({ sql: 'SELECT balance_wei FROM jars WHERE user_id = ?', args: [user.id] })).rows
      const allocated = all.reduce((sum, row) => sum + BigInt(String(row.balance_wei)), 0n)
      // ERC-20 refunds restore tokens, but do not restore the allowance consumed
      // by transferFrom. Only put spendable funds back into the jar budget.
      const credit = min(BigInt(String(p.amount_wei)), pos(available - allocated))
      const jar = (await tx.execute({ sql: 'SELECT balance_wei FROM jars WHERE user_id = ? AND kind = ?', args: [user.id, p.jar] })).rows[0]
      await tx.execute({ sql: 'UPDATE jars SET balance_wei = ? WHERE user_id = ? AND kind = ?', args: [String(BigInt(String(jar.balance_wei)) + credit), user.id, p.jar] })
      await tx.execute({ sql: "UPDATE payments SET status = 'refunded', refund_hash = ? WHERE id = ?", args: [hash, id] })
    })
    return hash
  })
}

/** Explicit withdrawal; retries reuse the original amount and transfer. */
export async function withdrawToWallet(input: User, requestId: string): Promise<{ hash: string; amountWei: bigint } | null> {
  const user = await authorizedUser(input)
  const request = await moneyRequest<{ amount: string; to: Address }>(user.id, `withdraw:${requestId}`, { action: 'withdraw' })
  if (request.result) return { hash: request.result.hash, amountWei: BigInt(request.result.amount) }
  if (!request.data) {
    const pending = await run("SELECT 1 FROM payments WHERE user_id = ? AND status IN ('reserved', 'refunding')", [user.id])
    if (pending.rows.length) throw new TransferPendingError()
    const p = await spendingPower(user)
    if (p.agentAvailWei === 0n) return null
    request.data = { amount: String(p.agentAvailWei), to: user.rootAddress! }
    await request.save(request.data)
  }
  const r = await transferFromAgent(decryptAgentKey(user.agentKeyEnc), request.data.to, BigInt(request.data.amount), { sponsor: true, operationId: request.id })
  await request.finish({ hash: r.hash, amount: request.data.amount })
  return { hash: r.hash, amountWei: BigInt(request.data.amount) }
}

export const gdText = (wei: bigint) => `G$ ${Number(formatEther(wei)).toLocaleString('en-US', { maximumFractionDigits: 0 })}`

export { GasLowError }
