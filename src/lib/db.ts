import { mkdirSync } from 'node:fs'
import path from 'node:path'
import { createClient, type Client, type InValue } from '@libsql/client'
import { serverConfig } from './env'

// SQLite locally (file:data/jara.db), Turso/libSQL in production.
// G$ amounts are stored as wei strings (18 decimals on Celo).
const SCHEMA = [
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
  ]) {
    try {
      await client.execute(sql)
    } catch {
      /* column already exists */
    }
  }
  return client
}

export async function run(sql: string, args: InValue[] = []) {
  return (await db()).execute({ sql, args })
}
