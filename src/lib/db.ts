import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { AsyncLocalStorage } from 'node:async_hooks'
import { createClient, type Client, type InValue, type Transaction } from '@libsql/client'
import { serverConfig } from './env'

// SQLite locally (file:data/jara.db), Turso/libSQL in production.
// G$ amounts are stored as wei strings (18 decimals on Celo).
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS referral_budget (id TEXT PRIMARY KEY, amount_gd INTEGER NOT NULL, created_at INTEGER NOT NULL)`,
  `CREATE TABLE IF NOT EXISTS exam_attempts (
    run_id INTEGER PRIMARY KEY REFERENCES ai_runs(id), user_id TEXT NOT NULL REFERENCES users(id),
    answers TEXT NOT NULL DEFAULT '[]', current_question INTEGER NOT NULL DEFAULT 0,
    submitted_at INTEGER, revision INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS wallet_bindings (root_address TEXT PRIMARY KEY, user_id TEXT NOT NULL UNIQUE)`,
  // Explicit operator grants for existing accounts sharing one verified wallet.
  // The original binding remains the default account for wallet sign-in.
  `CREATE TABLE IF NOT EXISTS wallet_sharing (
    user_id TEXT PRIMARY KEY REFERENCES users(id), root_address TEXT NOT NULL, created_at INTEGER NOT NULL
  )`,
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
  // Actions the AI assistant asked for that charge G$ or change payment settings. They run
  // only after the user approves this exact stored request (see lib/agent/approvals.ts).
  `CREATE TABLE IF NOT EXISTS approvals (
    id TEXT PRIMARY KEY,
    user_id TEXT NOT NULL REFERENCES users (id),
    tool TEXT NOT NULL,
    args TEXT NOT NULL,
    summary TEXT NOT NULL,
    cost_gd INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'pending',
    result TEXT,
    created_at INTEGER NOT NULL,
    decided_at INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS approvals_user_idx ON approvals (user_id, status)`,
  // Each time an owner revealed their Jara wallet key; a signature works once.
  `CREATE TABLE IF NOT EXISTS key_exports (signature TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users (id), created_at INTEGER NOT NULL)`,
  // One referral reward per verified GoodDollar identity, ever: the identity (root wallet),
  // not the Jara account, is what makes a referred person unique.
  `CREATE TABLE IF NOT EXISTS referral_identities (
    root_address TEXT PRIMARY KEY,
    referrer_id TEXT NOT NULL REFERENCES users (id),
    referred_user_id TEXT NOT NULL REFERENCES users (id),
    created_at INTEGER NOT NULL
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
    'ALTER TABLE users ADD COLUMN claimer_address TEXT',
    'ALTER TABLE users ADD COLUMN claimer_factory TEXT',
    'ALTER TABLE users ADD COLUMN claimer_active INTEGER NOT NULL DEFAULT 0',
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
  await leaveDemoMode(client)
  await renewRecurringConsent(client)
  // Referral rewards paid before identities were tracked (keyed "referral-<account id>")
  // count against that account's identity, so the same person is never paid for twice.
  await client.execute(`INSERT OR IGNORE INTO referral_identities (root_address, referrer_id, referred_user_id, created_at)
    SELECT lower(u.root_address), r.user_id, u.id, MIN(r.created_at)
    FROM rewards_paid r JOIN users u ON u.id = substr(r.reward_key, 10)
    WHERE r.reward_key GLOB 'referral-u_*' AND u.root_address IS NOT NULL
    GROUP BY lower(u.root_address)`)
  // Count historical confirmed and uncertain payouts against the same lifetime budget.
  await client.execute(`INSERT OR IGNORE INTO referral_budget(id, amount_gd, created_at)
    SELECT 'reward:' || user_id || ':' || reward_key, amount_gd, created_at FROM rewards_paid WHERE reward_key GLOB 'referral-*'`)
  await client.execute(`INSERT OR IGNORE INTO referral_budget(id, amount_gd, created_at)
    SELECT id, CAST(json_extract(intent, '$.transfer.amount') AS REAL) / 1e18, created_at FROM chain_transactions
    WHERE id GLOB 'reward:*:referral-*' AND json_extract(intent, '$.transfer.amount') IS NOT NULL`)
  return client
}

/** A database is permanently assigned to one money mode. Never erase journals on a mode switch. */
async function leaveDemoMode(client: Client) {
  await client.execute('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)')
  const mode = serverConfig().chain.mode
  const previous = (await client.execute("SELECT value FROM meta WHERE key = 'chain_mode'")).rows[0]
  if (!previous && Number((await client.execute('SELECT COUNT(*) AS n FROM users')).rows[0].n) > 0) { client.close(); throw new Error('Existing database has no money-mode marker. Verify its provenance before assigning a mode.') }
  await client.execute({ sql: "INSERT OR IGNORE INTO meta (key, value) VALUES ('chain_mode', ?)", args: [mode] })
  const stored = (await client.execute("SELECT value FROM meta WHERE key = 'chain_mode'")).rows[0]?.value
  if (stored !== mode) { client.close(); throw new Error('Database money mode does not match CHAIN_MODE. Use a separate database; existing funds and journals are unchanged.') }
}

/** Old recurring settings had no enforceable consent. Pause once, retaining settings and recovery journals. */
async function renewRecurringConsent(client: Client) {
  const tx = await client.transaction('write')
  try {
    const claimed = await tx.execute("INSERT OR IGNORE INTO meta(key, value) VALUES ('consent_reset_v1', 'done')")
    if (claimed.rowsAffected) {
      await tx.execute(`INSERT INTO messages(user_id, role, content, created_at)
        SELECT id, 'assistant', 'For your safety, existing automatic bill payments and paid scheduled jobs have been paused. Review your settings and explicitly enable them again. Payments already submitted will still be reconciled.', ${Date.now()}
        FROM users WHERE EXISTS (SELECT 1 FROM jars WHERE user_id = users.id AND auto_pay = 1)
        OR EXISTS (SELECT 1 FROM agent_jobs WHERE user_id = users.id AND (exam_on = 1 OR scout_on = 1))`)
      await tx.execute('UPDATE jars SET auto_pay = 0')
      await tx.execute('UPDATE agent_jobs SET exam_on = 0, scout_on = 0')
      // Revoke sessions and login links potentially exposed in group chats.
      await tx.execute("UPDATE users SET tg_chat_id = NULL, session_token = lower(hex(randomblob(24))), link_code = lower(hex(randomblob(12))) WHERE tg_chat_id IS NOT NULL AND (tg_chat_id GLOB '*[^0-9]*' OR tg_chat_id NOT GLOB '[1-9]*')")
    }
    await tx.commit()
  } catch (err) { await tx.rollback(); throw err } finally { tx.close() }
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
