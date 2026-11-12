import type { Row } from '@libsql/client'
import { createPublicClient, createWalletClient, http, keccak256, parseAbi, parseEventLogs, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { celo } from 'viem/chains'
import { run } from './db'
import { serverConfig } from './env'
import { withMoneyLock } from './money-lock'

export class TransferPendingError extends Error {
  constructor(readonly hash?: string) {
    super('Payment confirmation is pending. Retry the same request; do not start a new payment.')
  }
}
export class TransferRevertedError extends Error {
  constructor(readonly hash: string) { super(`The transaction did not complete the G$ transfer (${hash}).`) }
}
interface TransferExpectation { token: Address; from: Address; to: Address; amount: string }
const transferAbi = parseAbi(['event Transfer(address indexed from, address indexed to, uint256 value)'])

// Persist the signed bytes BEFORE broadcasting. Replaying those bytes has the
// same hash and nonce, including after a crash between broadcast and response.
export async function durableTransaction(id: string, key: Hex, input: { to: Address; data?: Hex; value?: bigint; transfer?: TransferExpectation }) {
  const account = privateKeyToAccount(key)
  const transport = http(serverConfig().chain.rpcUrl)
  const wallet = createWalletClient({ account, chain: celo, transport })
  const intent = JSON.stringify({ to: input.to.toLowerCase(), data: input.data ?? '0x', value: String(input.value ?? 0n), ...(input.transfer ? { transfer: input.transfer } : {}) })
  // One wallet signs for everyone (the treasury), so wait our turn rather than fail.
  return withMoneyLock(`signer:${account.address.toLowerCase()}`, async () => {
    let row = (await run('SELECT * FROM chain_transactions WHERE id = ?', [id])).rows[0]
    if (row && (row.intent !== intent || row.sender !== account.address.toLowerCase())) throw new Error('Transaction intent does not match its saved request.')
    if (!row) {
      // Do not assign a second transaction the nonce of an unconfirmed one.
      let pending = (await run("SELECT * FROM chain_transactions WHERE sender = ? AND status = 'pending'", [account.address.toLowerCase()])).rows[0]
      if (pending) {
        // An earlier transaction from this signer timed out. Usually it has landed by now: settle it, then go on.
        await settleSignedTransaction(pending).catch(() => undefined)
        pending = (await run("SELECT id FROM chain_transactions WHERE sender = ? AND status = 'pending'", [account.address.toLowerCase()])).rows[0]
      }
      if (pending) throw new TransferPendingError()
      const prepared = await wallet.prepareTransactionRequest({ to: input.to, data: input.data, value: input.value })
      const raw = await wallet.signTransaction(prepared)
      const hash = keccak256(raw)
      await run('INSERT INTO chain_transactions(id, sender, intent, raw, hash, created_at) VALUES (?, ?, ?, ?, ?, ?)', [id, account.address.toLowerCase(), intent, raw, hash, Date.now()])
      row = (await run('SELECT * FROM chain_transactions WHERE id = ?', [id])).rows[0]
    }
    return settleSignedTransaction(row)
  }, { waitMs: 60_000 })
}

export async function hasSubmittedTransaction(id: string): Promise<boolean> {
  return (await run('SELECT 1 FROM chain_transactions WHERE id = ?', [id])).rows.length > 0
}

async function settleSignedTransaction(row: Row) {
  const publicClient = createPublicClient({ chain: celo, transport: http(serverConfig().chain.rpcUrl) })
  const hash = row.hash as Hex
  if (row.status === 'reverted') throw new TransferRevertedError(hash)
  if (row.status === 'confirmed') return { hash, feeWei: BigInt(String(row.fee_wei)) }
  let receipt = await publicClient.getTransactionReceipt({ hash }).catch(() => null)
  if (!receipt) {
    // Already-known, timeout and nonce errors are all ambiguous. The receipt,
    // never the send RPC response, decides whether the transfer succeeded.
    await publicClient.sendRawTransaction({ serializedTransaction: row.raw as Hex }).catch(() => undefined)
    receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 30_000, confirmations: 2 }).catch(() => null)
  } else if (await publicClient.getBlockNumber() < receipt.blockNumber + 1n) {
    receipt = await publicClient.waitForTransactionReceipt({ hash, timeout: 30_000, confirmations: 2 }).catch(() => null)
  }
  if (!receipt) throw new TransferPendingError(hash)
  const feeWei = receipt.gasUsed * receipt.effectiveGasPrice
  const expected = (JSON.parse(String(row.intent)) as { transfer?: TransferExpectation }).transfer
  const transferred = !expected || parseEventLogs({ abi: transferAbi, eventName: 'Transfer', logs: receipt.logs }).some((event) =>
    event.address.toLowerCase() === expected.token.toLowerCase() && event.args.from.toLowerCase() === expected.from.toLowerCase() && event.args.to.toLowerCase() === expected.to.toLowerCase() && event.args.value === BigInt(expected.amount))
  if (receipt.status === 'reverted') {
    await run("UPDATE chain_transactions SET status = 'reverted', fee_wei = ? WHERE id = ?", [feeWei.toString(), row.id])
    throw new TransferRevertedError(hash)
  }
  // A successful receipt with unexpected token logs does not prove that nothing
  // moved. Retain the reservation/signer nonce until the transfer is reconciled.
  if (receipt.status !== 'success' || !transferred) {
    console.warn('[chain] receipt needs transfer reconciliation', hash)
    throw new TransferPendingError(hash)
  }
  await run("UPDATE chain_transactions SET status = 'confirmed', fee_wei = ? WHERE id = ?", [feeWei.toString(), row.id])

  return { hash, feeWei }
}

/** Only broadcasts bytes already signed and saved by an authorized operation. */
export async function recoverChainTransactions() {
  const pending = (await run("SELECT * FROM chain_transactions WHERE status = 'pending' ORDER BY created_at LIMIT 20")).rows
  for (const row of pending) {
    await withMoneyLock(`signer:${row.sender}`, () => settleSignedTransaction(row)).catch(() => undefined)
  }
}
