import { randomBytes } from 'node:crypto'
import type { Row } from '@libsql/client'
import { run } from './db'
import { createAgentWallet } from './wallets'
import { serverConfig } from './env'

export const JAR_KINDS = ['light', 'data', 'airtime', 'ai'] as const
export type JarKind = (typeof JAR_KINDS)[number]
/** Jars that pay a bill through the top-up provider. The AI jar pays for AI helpers instead. */
export const BILL_KINDS = ['light', 'data', 'airtime'] as const
export type BillKind = (typeof BILL_KINDS)[number]
export const isBillKind = (v: unknown): v is BillKind => typeof v === 'string' && (BILL_KINDS as readonly string[]).includes(v)

export const JAR_INFO: Record<JarKind, { label: string; emoji: string; defaultTarget: number }> = {
  light: { label: 'Light', emoji: '💡', defaultTarget: 3000 },
  data: { label: 'Data', emoji: '📶', defaultTarget: 1000 },
  airtime: { label: 'Airtime', emoji: '📞', defaultTarget: 500 },
  ai: { label: 'AI', emoji: '✨', defaultTarget: 500 },
}

export function isJarKind(v: unknown): v is JarKind {
  return typeof v === 'string' && (JAR_KINDS as readonly string[]).includes(v)
}

/** A bill the agent proposed and is waiting for the user to confirm. */
export interface PendingAction {
  id?: string
  quoteWei?: string
  kind: BillKind
  amountNgn: number
  phone?: string
  network?: string
  planCode?: string
  planName?: string
  disco?: string
  meterType?: string
  meterNumber?: string
  forWhom?: string
  createdAt: number
}

export interface User {
  id: string
  name: string | null
  sessionToken: string
  tgChatId: string | null
  /** Secret, single-use sign-in/link code (Telegram buttons). Rotated after each use. */
  linkCode: string
  /** Public referral code for invite links. Never signs anyone in. */
  refCode: string | null
  rootAddress: `0x${string}` | null
  agentAddress: `0x${string}`
  agentKeyEnc: string
  claimerAddress: `0x${string}` | null
  claimerFactory: `0x${string}` | null
  claimerActive: boolean
  connected: boolean
  streak: number
  lastClaimDay: string | null
  pending: PendingAction | null
  skills: string[]
  city: string | null
  referredBy: string | null
  lastRunAt: number | null
  createdAt: number
}

function toUser(r: Row): User {
  return {
    id: r.id as string,
    name: (r.name as string) ?? null,
    sessionToken: r.session_token as string,
    tgChatId: (r.tg_chat_id as string) ?? null,
    linkCode: r.link_code as string,
    refCode: (r.ref_code as string | null) ?? null,
    rootAddress: (r.root_address as `0x${string}`) ?? null,
    agentAddress: r.agent_address as `0x${string}`,
    agentKeyEnc: r.agent_key_enc as string,
    claimerAddress: (r.claimer_address as `0x${string}`) ?? null,
    claimerFactory: (r.claimer_factory as `0x${string}`) ?? null,
    claimerActive: Number(r.claimer_active) === 1,
    connected: Number(r.connected) === 1,
    streak: Number(r.streak),
    lastClaimDay: (r.last_claim_day as string) ?? null,
    pending: r.pending_action ? (JSON.parse(r.pending_action as string) as PendingAction) : null,
    skills: r.skills ? (JSON.parse(r.skills as string) as string[]) : [],
    city: (r.city as string) ?? null,
    referredBy: (r.referred_by as string) ?? null,
    lastRunAt: r.last_run_at === null || r.last_run_at === undefined ? null : Number(r.last_run_at),
    createdAt: Number(r.created_at),
  }
}

async function one(sql: string, args: (string | number | null)[]): Promise<User | null> {
  const r = await run(sql, args)
  return r.rows[0] ? toUser(r.rows[0]) : null
}

export async function createUser(input: { name?: string; tgChatId?: string; referredBy?: string } = {}): Promise<User> {
  const id = `u_${randomBytes(8).toString('hex')}`
  // Placeholder preserves the legacy NOT NULL/UNIQUE schema. It is never shown as
  // a deposit address or used on-chain; there is deliberately no corresponding key.
  const wallet = serverConfig().chain.mode === 'celo' && serverConfig().chain.claimerFactory
    ? { address: `0x${randomBytes(20).toString('hex')}`, encryptedKey: 'keyless' }
    : await createAgentWallet()
  await run(
    `INSERT INTO users (id, name, session_token, tg_chat_id, link_code, agent_address, agent_key_enc, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      id,
      input.name ?? null,
      randomBytes(24).toString('hex'),
      input.tgChatId ?? null,
      randomBytes(12).toString('hex'),
      wallet.address,
      wallet.encryptedKey,
      Date.now(),
    ],
  )
  if (input.referredBy) await run('UPDATE users SET referred_by = ? WHERE id = ?', [input.referredBy, id])
  for (const kind of JAR_KINDS) {
    await run('INSERT INTO jars (user_id, kind, target_ngn) VALUES (?, ?, ?)', [id, kind, JAR_INFO[kind].defaultTarget])
  }
  return (await getUserById(id))!
}

export const getUserById = (id: string) => one('SELECT * FROM users WHERE id = ?', [id])
export const getUserBySession = (t: string) => one('SELECT * FROM users WHERE session_token = ?', [t])
export const getUserByTelegram = (chatId: string) => one('SELECT * FROM users WHERE tg_chat_id = ?', [chatId])
export const getUserByLinkCode = (code: string) => one('SELECT * FROM users WHERE link_code = ?', [code])
export const getUserByRefCode = (code: string) => one('SELECT * FROM users WHERE ref_code = ?', [code])

/** Replace the sign-in/link code once it has been used, so a forwarded or leaked link stops working. */
export async function rotateLinkCode(userId: string): Promise<string> {
  const code = randomBytes(12).toString('hex')
  await run('UPDATE users SET link_code = ? WHERE id = ?', [code, userId])
  return code
}

/** The user's public referral code, created on first use. */
export async function ensureRefCode(user: User): Promise<string> {
  if (user.refCode) return user.refCode
  const code = randomBytes(5).toString('hex')
  await run('UPDATE users SET ref_code = ? WHERE id = ? AND ref_code IS NULL', [code, user.id])
  return (await getUserById(user.id))!.refCode ?? code
}

export async function listConnectedUsers(): Promise<User[]> {
  const r = await run('SELECT * FROM users WHERE connected = 1')
  return r.rows.map(toUser)
}

export async function updateUser(
  id: string,
  patch: Partial<{
    name: string | null
    tgChatId: string | null
    rootAddress: string | null
    connected: boolean
    streak: number
    lastClaimDay: string | null
    pending: PendingAction | null
    skills: string[]
    city: string | null
    lastRunAt: number
  }>,
) {
  const cols: Record<string, string | number | null> = {}
  if ('name' in patch) cols.name = patch.name ?? null
  if ('tgChatId' in patch) cols.tg_chat_id = patch.tgChatId ?? null
  if ('rootAddress' in patch) cols.root_address = patch.rootAddress ?? null
  if ('connected' in patch) cols.connected = patch.connected ? 1 : 0
  if ('streak' in patch) cols.streak = patch.streak ?? 0
  if ('lastClaimDay' in patch) cols.last_claim_day = patch.lastClaimDay ?? null
  if ('pending' in patch) cols.pending_action = patch.pending ? JSON.stringify(patch.pending) : null
  if ('skills' in patch) cols.skills = JSON.stringify(patch.skills ?? [])
  if ('city' in patch) cols.city = patch.city ?? null
  if ('lastRunAt' in patch) cols.last_run_at = patch.lastRunAt ?? null
  const keys = Object.keys(cols)
  if (!keys.length) return
  await run(`UPDATE users SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...Object.values(cols), id])
}

/** Move a Telegram chat onto an existing (web-created) user. */
export async function linkTelegram(userId: string, chatId: string) {
  if (!/^[1-9][0-9]*$/.test(chatId)) throw new Error('Link Telegram from your private chat with Jara.')
  await run('UPDATE users SET tg_chat_id = NULL WHERE tg_chat_id = ? AND id != ?', [chatId, userId])
  await updateUser(userId, { tgChatId: chatId })
}

// ---------- activity ----------

export type ActivityType = 'claim' | 'deposit' | 'pay' | 'refund' | 'reward' | 'move' | 'ai' | 'agent'

export interface Activity {
  id: number
  type: ActivityType
  jar: JarKind | null
  amountWei: string | null
  amountNgn: number | null
  txHash: string | null
  status: 'done' | 'pending' | 'failed' | 'refund_pending'
  title: string
  detail: string | null
  createdAt: number
}

export async function logActivity(
  userId: string,
  a: Omit<Activity, 'id' | 'createdAt' | 'status' | 'jar' | 'amountWei' | 'amountNgn' | 'txHash' | 'detail'> &
    Partial<Pick<Activity, 'status' | 'jar' | 'amountWei' | 'amountNgn' | 'txHash' | 'detail'>>,
): Promise<number> {
  const r = await run(
    `INSERT INTO activity (user_id, type, jar, amount_wei, amount_ngn, tx_hash, status, title, detail, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      userId,
      a.type,
      a.jar ?? null,
      a.amountWei ?? null,
      a.amountNgn ?? null,
      a.txHash ?? null,
      a.status ?? 'done',
      a.title,
      a.detail ?? null,
      Date.now(),
    ],
  )
  return Number(r.lastInsertRowid)
}

export async function updateActivity(id: number, patch: Partial<Pick<Activity, 'status' | 'title' | 'detail' | 'txHash'>>) {
  const cols: Record<string, string | null> = {}
  if (patch.status) cols.status = patch.status
  if (patch.title) cols.title = patch.title
  if ('detail' in patch) cols.detail = patch.detail ?? null
  if ('txHash' in patch) cols.tx_hash = patch.txHash ?? null
  const keys = Object.keys(cols)
  if (!keys.length) return
  await run(`UPDATE activity SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`, [...Object.values(cols), id])
}

export async function listActivity(userId: string, limit = 30): Promise<Activity[]> {
  const r = await run('SELECT * FROM activity WHERE user_id = ? ORDER BY id DESC LIMIT ?', [userId, limit])
  return r.rows.map((x) => ({
    id: Number(x.id),
    type: x.type as ActivityType,
    jar: (x.jar as JarKind) ?? null,
    amountWei: (x.amount_wei as string) ?? null,
    amountNgn: x.amount_ngn === null ? null : Number(x.amount_ngn),
    txHash: (x.tx_hash as string) ?? null,
    status: x.status as Activity['status'],
    title: x.title as string,
    detail: (x.detail as string) ?? null,
    createdAt: Number(x.created_at),
  }))
}
