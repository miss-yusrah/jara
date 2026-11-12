import { createPublicClient, createWalletClient, http, keccak256, parseAbi, toBytes, type Address, type Hex } from 'viem'
import { privateKeyToAccount } from 'viem/accounts'
import { celo } from 'viem/chains'
import { run } from './db'
import { serverConfig } from './env'

// Mirrors JaraTelemetry.Kind in contracts/src/JaraTelemetry.sol.
const KIND = { joined: 0, claim: 1, deposit: 2, ai: 3, pay: 4, refund: 5, reward: 6 } as const
const ACTIVITY_KINDS = ['claim', 'deposit', 'ai', 'pay', 'refund', 'reward'] as const
const BATCH = 50

const abi = parseAbi([
  'struct Entry { address user; uint8 kind; uint256 amount; bytes32 ref; bool demo; }',
  'function record(Entry[] entries)',
  'function summary(bool demo) view returns (uint256 userCount, uint256[7] amounts, uint256[7] counts)',
  'function circulation(bool demo) view returns (uint256)',
])

interface Entry {
  user: Address
  kind: number
  amount: bigint
  ref: Hex
  demo: boolean
}

export function telemetryConfig() {
  const address = process.env.TELEMETRY_CONTRACT as Address | undefined
  const key = process.env.TELEMETRY_REPORTER_KEY as Hex | undefined
  return { address, key, enabled: Boolean(address && key) }
}

// Real-mode events get their own namespace so they can never collide with refs already used by demo events
// (the database is reset when switching to real G$, so activity ids start again from 1).
const refOf = (s: string, demo: boolean) => keccak256(toBytes(demo ? `jara:${s}` : `jara:real:${s}`))

/** App events not yet written on-chain, oldest first: user joins, then completed G$ movements. */
async function pending(limit: number): Promise<{ id: string; entry: Entry }[]> {
  // Activity is flagged demo while the app runs on simulated G$ (CHAIN_MODE=mock).
  const demo = serverConfig().chain.mode === 'mock'
  const out: { id: string; entry: Entry }[] = []
  const joins = await run(
    `SELECT u.id, u.agent_address FROM users u
     WHERE u.connected = 1 AND NOT EXISTS (SELECT 1 FROM telemetry_sent t WHERE t.id = 'join:' || u.id)
     ORDER BY u.created_at LIMIT ?`,
    [limit],
  )
  for (const r of joins.rows) {
    const id = `join:${r.id}`
    out.push({ id, entry: { user: r.agent_address as Address, kind: KIND.joined, amount: 0n, ref: refOf(id, demo), demo } })
  }
  if (out.length >= limit) return out
  const acts = await run(
    `SELECT a.id, a.type, a.amount_wei, u.agent_address FROM activity a JOIN users u ON u.id = a.user_id
     WHERE a.status = 'done' AND a.amount_wei IS NOT NULL AND a.type IN (${ACTIVITY_KINDS.map(() => '?').join(',')})
       AND NOT EXISTS (SELECT 1 FROM telemetry_sent t WHERE t.id = 'act:' || a.id)
     ORDER BY a.id LIMIT ?`,
    [...ACTIVITY_KINDS, limit - out.length],
  )
  for (const r of acts.rows) {
    const amount = BigInt(String(r.amount_wei))
    if (amount <= 0n) continue
    const id = `act:${r.id}`
    out.push({ id, entry: { user: r.agent_address as Address, kind: KIND[r.type as keyof typeof KIND], amount, ref: refOf(id, demo), demo } })
  }
  return out
}

let flushing: Promise<unknown> | null = null

/** Writes pending app events to the JaraTelemetry contract in batches. Safe to call often. */
export async function flushTelemetry(maxBatches = 4): Promise<{ sent: number; txs: string[]; skipped?: string }> {
  const cfg = telemetryConfig()
  if (!cfg.enabled) return { sent: 0, txs: [], skipped: 'telemetry not configured' }
  if (flushing) return { sent: 0, txs: [], skipped: 'already running' }
  const job = (async () => {
    const account = privateKeyToAccount(cfg.key!)
    const transport = http(serverConfig().chain.rpcUrl)
    const pub = createPublicClient({ chain: celo, transport })
    const wallet = createWalletClient({ account, chain: celo, transport })
    let sent = 0
    const txs: string[] = []
    for (let b = 0; b < maxBatches; b++) {
      const batch = await pending(BATCH)
      if (!batch.length) break
      const hash = await wallet.writeContract({ address: cfg.address!, abi, functionName: 'record', args: [batch.map((x) => x.entry)] })
      const receipt = await pub.waitForTransactionReceipt({ hash })
      if (receipt.status !== 'success') throw new Error(`telemetry batch reverted: ${hash}`)
      for (const x of batch) await run('INSERT OR IGNORE INTO telemetry_sent (id, tx_hash, sent_at) VALUES (?, ?, ?)', [x.id, hash, Date.now()])
      sent += batch.length
      txs.push(hash)
    }
    return { sent, txs }
  })()
  flushing = job
  try {
    return await job
  } finally {
    flushing = null
  }
}

const KIND_NAMES = ['joined', 'claimed', 'deposited', 'aiSpent', 'billPaid', 'refunded', 'rewarded'] as const

/** On-chain totals, read straight from the contract. */
export async function telemetrySummary() {
  const cfg = telemetryConfig()
  if (!cfg.address) return null
  const pub = createPublicClient({ chain: celo, transport: http(serverConfig().chain.rpcUrl) })
  const read = async (demo: boolean) => {
    const [userCount, amounts, counts] = await pub.readContract({ address: cfg.address!, abi, functionName: 'summary', args: [demo] })
    const circ = await pub.readContract({ address: cfg.address!, abi, functionName: 'circulation', args: [demo] })
    return {
      users: Number(userCount),
      circulationGd: Number(circ / 10n ** 18n),
      byKind: Object.fromEntries(KIND_NAMES.map((k, i) => [k, { gd: Number(amounts[i] / 10n ** 18n), events: Number(counts[i]) }])),
    }
  }
  return { contract: cfg.address, chain: 'celo', real: await read(false), demo: await read(true) }
}
