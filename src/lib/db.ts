import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import path from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createClient, type Client, type InValue, type Transaction } from '@libsql/client'
import { serverConfig } from './env'

// SQLite locally (file:data/jara.db), Turso/libSQL in production.
// G$ amounts are stored as wei strings (18 decimals on Celo).
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS exam_attempts (
    run_id INTEGER PRIMARY KEY REFERENCES ai_runs(id), user_id TEXT NOT NULL REFERENCES users(id),
    answers TEXT NOT NULL DEFAULT '[]', current_question INTEGER NOT NULL DEFAULT 0,
    submitted_at INTEGER, revision INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS wallet_bindings (root_address TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE)`,
  `CREATE TABLE IF NOT EXISTS money_locks (id TEXT PRIMARY KEY, owner TEXT NOT NULL, expires_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS chain_transactions (
    id TEXT PRIMARY KEY, sender TEXT NOT NULL, intent TEXT NOT NULL,
    raw TEXT NOT NULL, hash TEXT NOT NULL UNIQUE, status TEXT NOT NULL DEFAULT 'pending',
    fee_wei TEXT NOT NULL DEFAULT '0', created_at INTEGER NOT NULL
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS chain_sender_pending ON chain_transactions(sender) WHERE status = 'pending'`,
  `CREATE TABLE IF NOT EXISTS payments (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, jar TEXT NOT NULL, amount_wei TEXT NOT NULL,
    source TEXT NOT NULL, refund_address TEXT NOT NULL, fees_wei TEXT NOT NULL DEFAULT '0',
    status TEXT NOT NULL DEFAULT 'reserved', tx_hash TEXT, refund_hash TEXT, created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS money_requests (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, fingerprint TEXT NOT NULL,
    data TEXT, result TEXT, created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS bill_notices (activity_id INTEGER PRIMARY KEY, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY,
    name TEXT,
    session_token TEXT UNIQUE,
    tg_chat_id TEXT UNIQUE,
    link_code TEXT UNIQUE,
    root_address TEXT,
    agent_address TEXT NOT NULL UNIQUE,
    agent_key_enc TEXT NOT NULL,
    connected INTEGER NOT NULL DEFAULT 0,
    streak INTEGER NOT NULL DEFAULT 0,
    last_claim_day TEXT,
    pending_action TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS jars (
    user_id TEXT NOT NULL REFERENCES users (id),
    kind TEXT NOT NULL,
    balance_wei TEXT NOT NULL DEFAULT '0',
    target_ngn INTEGER NOT NULL,
    auto_pay INTEGER NOT NULL DEFAULT 0,
    details TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (user_id, kind)
  )`,
  `CREATE TABLE IF NOT EXISTS activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users (id),
    type TEXT NOT NULL,
    jar TEXT,
    amount_wei TEXT,
    amount_ngn INTEGER,
    tx_hash TEXT,
    status TEXT NOT NULL DEFAULT 'done',
    title TEXT NOT NULL,
    detail TEXT,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS activity_user_idx ON activity (user_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users (id),
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS messages_user_idx ON messages (user_id, id)`,
  // USDC the operator has put into AntSeed, to track how much G$ has paid it back.
  `CREATE TABLE IF NOT EXISTS treasury_topups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    amount_usd REAL NOT NULL,
    note TEXT,
    created_at INTEGER NOT NULL
  )`,
  // Jara AI chat: conversations and their messages.
  `CREATE TABLE IF NOT EXISTS ai_chats (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users (id),
    tool TEXT NOT NULL,
    title TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ai_chats_user_idx ON ai_chats (user_id, updated_at)`,
  `CREATE TABLE IF NOT EXISTS ai_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id TEXT NOT NULL REFERENCES ai_chats (id),
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    cost_gd INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ai_messages_chat_idx ON ai_messages (chat_id, id)`,
  // AI helper uses, paid in G$.
  `CREATE TABLE IF NOT EXISTS ai_runs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id TEXT NOT NULL REFERENCES users (id),
    tool TEXT NOT NULL,
    input TEXT NOT NULL,
    output TEXT NOT NULL,
    cost_gd INTEGER NOT NULL,
    demo INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS ai_runs_user_idx ON ai_runs (user_id, id)`,
  `CREATE TABLE IF NOT EXISTS telemetry_sent (
    id TEXT PRIMARY KEY,
    tx_hash TEXT NOT NULL,
    sent_at INTEGER NOT NULL
  )`,
  // One row per reward a user has received, keyed so each reward pays once per period.
  `CREATE TABLE IF NOT EXISTS rewards_paid (
    user_id TEXT NOT NULL REFERENCES users (id),
    reward_key TEXT NOT NULL,
    amount_gd INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, reward_key)
  )`,
  // Simulated balances for CHAIN_MODE=mock.
  `CREATE TABLE IF NOT EXISTS mock_balances (address TEXT PRIMARY KEY, wei TEXT NOT NULL)`,
  // Proactive jobs the user switched on: daily exam drills, opportunity scout, verification reminders.
  `CREATE TABLE IF NOT EXISTS agent_jobs (
    user_id TEXT PRIMARY KEY REFERENCES users (id),
    exam_on INTEGER NOT NULL DEFAULT 0,
    exam TEXT,
    exam_subjects TEXT NOT NULL DEFAULT '[]',
    exam_date TEXT,
    exam_last_day TEXT,
    exam_count INTEGER NOT NULL DEFAULT 0,
    scout_on INTEGER NOT NULL DEFAULT 0,
    scout_interests TEXT,
    scout_last_at INTEGER,
    verify_warned_at INTEGER
  )`,
  `CREATE TABLE IF NOT EXISTS scout_seen (
    user_id TEXT NOT NULL REFERENCES users (id),
    link TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, link)
  )`,
]

const globalForDb = globalThis as typeof globalThis & { __jaraDb?: Promise<Client> }

export function db(): Promise<Client> {
  globalForDb.__jaraDb ??= connect().catch((err: unknown) => {
    globalForDb.__jaraDb = undefined
    throw err
  })
  return globalForDb.__jaraDb
}

async function connect(): Promise<Client> {
  const { url, authToken } = serverConfig().db
  if (url.startsWith('file:')) mkdirSync(path.dirname(url.slice('file:'.length)), { recursive: true })
  const client = createClient({ url, authToken })
  await client.batch(SCHEMA, 'write')
  // Columns added after the first release.
  for (const sql of [
    'ALTER TABLE users ADD COLUMN skills TEXT NOT NULL DEFAULT \'[]\'',
    'ALTER TABLE users ADD COLUMN city TEXT',
    'ALTER TABLE users ADD COLUMN referred_by TEXT',
    'ALTER TABLE users ADD COLUMN last_run_at INTEGER',
    // Public referral code, kept separate from link_code (which signs people in).
    'ALTER TABLE users ADD COLUMN ref_code TEXT',
    'CREATE UNIQUE INDEX IF NOT EXISTS users_ref_code_idx ON users (ref_code)',
    'ALTER TABLE jars ADD COLUMN every_days INTEGER',
    'ALTER TABLE jars ADD COLUMN last_paid_at INTEGER',
    // Bill payments still processing at the provider, so they can be settled later.
    'ALTER TABLE activity ADD COLUMN provider TEXT',
    'ALTER TABLE activity ADD COLUMN provider_ref TEXT',
    // Network fees Jara paid in CELO for this person, owed back in G$ (wei).
    "ALTER TABLE users ADD COLUMN gas_owed_wei TEXT NOT NULL DEFAULT '0'",
    'CREATE INDEX IF NOT EXISTS activity_provider_ref_idx ON activity (provider_ref)',
    'ALTER TABLE activity ADD COLUMN operation_id TEXT',
    'CREATE UNIQUE INDEX IF NOT EXISTS activity_operation_idx ON activity(operation_id)',
  ]) {
    try {
      await client.execute(sql)
    } catch {
      /* column already exists */
    }
  }
  await leaveDemoMode(client, url)
  return client
}

/**
 * Runs once, the first time the app starts with CHAIN_MODE=celo on a database
 * that was used in demo mode. Demo balances, claims, rewards and "connections"
 * were simulated, so they're cleared: otherwise real treasury G$ could be paid
 * out for demo activity (weekly saver, first AI, referrals), and demo users
 * would look connected without an on-chain link. Accounts, chats and settings stay.
 */
async function leaveDemoMode(client: Client, url: string) {
  await client.execute('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  const mode = serverConfig().chain.mode
  const stored = (await client.execute("SELECT value FROM meta WHERE key = 'chain_mode'")).rows[0]?.value as string | undefined
  if (mode !== 'celo') {
    if (!stored) await client.execute({ sql: "INSERT INTO meta (key, value) VALUES ('chain_mode', ?)", args: [mode] })
    return
  }
  if (stored === 'celo') return
  if (url.startsWith('file:')) {
    const file = url.slice('file:'.length)
    if (existsSync(file)) copyFileSync(file, `${file}.demo-backup-${Date.now()}`)
  }
  await client.batch(
    [
      'UPDATE users SET connected = 0, root_address = NULL, streak = 0, last_claim_day = NULL, pending_action = NULL',
      "UPDATE jars SET balance_wei = '0', last_paid_at = NULL",
      'DELETE FROM activity',
      'DELETE FROM rewards_paid',
      'DELETE FROM mock_balances',
      // Demo joins were logged on-chain as demo; let real connections be logged again as real.
      "DELETE FROM telemetry_sent WHERE id LIKE 'join:%'",
      'UPDATE ai_runs SET demo = 1',
      "INSERT INTO meta (key, value) VALUES ('chain_mode', 'celo') ON CONFLICT (key) DO UPDATE SET value = 'celo'",
    ],
    'write',
  )
  console.warn('[jara] switched to CHAIN_MODE=celo: demo balances, activity and connections cleared')
}

export async function run(sql: string, args: InValue[] = []) {
  if (moneyLockContext.getStore()?.size && !/^\s*SELECT\b/i.test(sql)) {
    return atomic((tx) => tx.execute({ sql, args }))
  }
  return executeStatement(sql, args)
}

// Retry only SQLite's explicit contention error, and only at boundaries that
// have not committed work. Yield so another request can release its lock;
// a synchronous SQLite busy timeout would block that request's event loop.
async function retryDatabaseBusy<T>(fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 1_000
  for (let attempt = 0; ; attempt++) {
    try {
      return await fn()
    } catch (error) {
      if (!error || typeof error !== 'object' || !('code' in error) || error.code !== 'SQLITE_BUSY' || Date.now() >= deadline) throw error
      await new Promise((resolve) => setTimeout(resolve, Math.min(20 * 2 ** Math.min(attempt, 3), 100, deadline - Date.now())))
    }
  }
}

// Standalone statements only. Money-lock bookkeeping uses this directly so
// acquiring/releasing a lease does not itself require holding that lease.
export async function executeStatement(sql: string, args: InValue[] = []) {
  const shared = await db()
  return retryDatabaseBusy(async () => {
    const client = operationClient(shared)
    try {
      return await client.execute({ sql, args })
    } finally {
      if (client !== shared) client.close()
    }
  })
}

// The local driver can leave a failed statement active after SQLITE_BUSY.
// Keep each local operation's connection private and close it on completion,
// including failed BEGIN attempts. Remote clients keep their normal pooling.
function operationClient(shared: Client): Client {
  const config = serverConfig().db
  return config.url.startsWith('file:') ? createClient(config) : shared
}

// Every ledger write checks lease ownership inside the same database transaction.
// A worker that resumes after losing its lease cannot mutate the ledger.
export const moneyLockContext = new AsyncLocalStorage<Map<string, string>>()

export async function atomic<T>(fn: (tx: Transaction) => Promise<T>): Promise<T> {
  const shared = await db()
  const { client, tx } = await retryDatabaseBusy(async () => {
    const client = operationClient(shared)
    try {
      return { client, tx: await client.transaction('write') }
    } catch (error) {
      if (client !== shared) client.close()
      throw error
    }
  })
  try {
    for (const [id, owner] of moneyLockContext.getStore() ?? []) {
      const lock = await tx.execute({ sql: 'SELECT 1 FROM money_locks WHERE id = ? AND owner = ? AND expires_at > ?', args: [id, owner, Date.now()] })
      if (!lock.rows.length) throw new Error('This operation lost its lock. Retry the same request.')
    }
    const result = await fn(tx)
    await tx.commit()
    return result
  } catch (err) {
    await tx.rollback()
    throw err
  } finally {
    tx.close()
    if (client !== shared) client.close()
  }
}
