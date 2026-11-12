/* eslint-disable @typescript-eslint/no-require-imports */
const { test, after } = require('node:test')
const assert = require('node:assert/strict')
const { mkdtempSync, rmSync } = require('node:fs')
const { tmpdir } = require('node:os')
const path = require('node:path')
const Module = require('node:module')
const { keccak256 } = require('viem')
const directory = mkdtempSync(path.join(tmpdir(), 'jara-outbox-'))
process.env.DATABASE_URL = `file:${directory}/test.db`
process.env.CHAIN_MODE = 'mock'
const { db, run } = require('../src/lib/db.ts')

// Exercise the production signing/persistence/receipt flow with a deterministic
// RPC boundary. No transaction is sent to a real network.
let signed = 0
let broadcasts = 0
let outcome = null
const receipts = new Map()
const load = Module._load
Module._load = function (name, parent, ...args) {
  const actual = load.call(this, name, parent, ...args)
  if (name !== 'viem' || !parent?.filename.endsWith('chain-outbox.ts')) return actual
  return {
    ...actual,
    createWalletClient: () => ({
      prepareTransactionRequest: async (input) => input,
      signTransaction: async () => `0x${(++signed).toString(16).padStart(8, '0')}`,
    }),
    createPublicClient: () => ({
      getBlockNumber: async () => 102n,
      getTransactionReceipt: async ({ hash }) => {
        if (!receipts.has(hash)) throw new Error('not mined')
        return receipts.get(hash)
      },
      sendRawTransaction: async ({ serializedTransaction }) => {
        broadcasts++
        const hash = keccak256(serializedTransaction)
        const persisted = (await run('SELECT raw FROM chain_transactions WHERE hash = ?', [hash])).rows[0]
        assert.equal(persisted.raw, serializedTransaction, 'signed bytes must exist before broadcasting')
        if (outcome) receipts.set(hash, { status: outcome, blockNumber: 100n, gasUsed: 10n, effectiveGasPrice: 2n, logs: [] })
        throw new Error('RPC response lost after acceptance')
      },
      waitForTransactionReceipt: async ({ hash }) => {
        if (!receipts.has(hash)) throw new Error('timeout')
        return receipts.get(hash)
      },
    }),
  }
}
let outbox = require('../src/lib/chain-outbox.ts')
const key = `0x${'1'.repeat(64)}`
const intent = { to: `0x${'2'.repeat(40)}`, value: 100n }

test('persist-before-broadcast, crash recovery, nonce isolation and confirmed replay', async () => {
  await assert.rejects(outbox.durableTransaction('payment-1', key, intent), outbox.TransferPendingError)
  const original = (await run('SELECT * FROM chain_transactions WHERE id = ?', ['payment-1'])).rows[0]
  assert.equal(original.status, 'pending')
  assert.equal(signed, 1)
  await assert.rejects(outbox.durableTransaction('payment-2', key, intent), outbox.TransferPendingError)
  assert.equal(signed, 1, 'a second payment must not reuse an unresolved sender nonce')
  await assert.rejects(outbox.durableTransaction('payment-1', key, { ...intent, value: 200n }), /intent does not match/)
  delete require.cache[require.resolve('../src/lib/chain-outbox.ts')]
  outbox = require('../src/lib/chain-outbox.ts')
  outcome = 'success'
  const recovered = await outbox.durableTransaction('payment-1', key, intent)
  assert.equal(recovered.hash, original.hash)
  assert.equal(recovered.feeWei, 20n)
  assert.equal(signed, 1, 'recovery must never sign a replacement charge')
  const previousBroadcasts = broadcasts
  assert.deepEqual(await outbox.durableTransaction('payment-1', key, intent), recovered)
  assert.equal(broadcasts, previousBroadcasts)
})

test('a reverted receipt remains failed on every retry', async () => {
  outcome = 'reverted'
  await assert.rejects(outbox.durableTransaction('payment-reverted', key, intent), outbox.TransferRevertedError)
  const row = (await run('SELECT * FROM chain_transactions WHERE id = ?', ['payment-reverted'])).rows[0]
  assert.equal(row.status, 'reverted')
  const previousSigned = signed
  const previousBroadcasts = broadcasts
  await assert.rejects(outbox.durableTransaction('payment-reverted', key, intent), outbox.TransferRevertedError)
  assert.equal(signed, previousSigned)
  assert.equal(broadcasts, previousBroadcasts)
})

test('a successful receipt without the expected token transfer is not a successful payment', async () => {
  outcome = 'success'
  await assert.rejects(outbox.durableTransaction('missing-transfer-event', key, {
    ...intent,
    transfer: { token: intent.to, from: intent.to, to: intent.to, amount: '100' },
  }), outbox.TransferRevertedError)
  assert.equal((await run('SELECT status FROM chain_transactions WHERE id = ?', ['missing-transfer-event'])).rows[0].status, 'reverted')
})

after(async () => {
  Module._load = load
  const client = await db()
  client.close()
  rmSync(directory, { recursive: true, force: true })
})
