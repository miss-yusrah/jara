import { randomUUID } from 'node:crypto'
import { run } from '../db'

// Server-side consent for actions the AI assistant asks for.
//
// A tool that charges G$ or changes how money is paid never runs when the model calls
// it. The server validates the arguments, stores them here as a pending approval and
// shows the user exactly what will happen. Only the user's own confirmation (the
// Confirm button, or a plain "yes" message checked by the server before any model
// call) moves the row to "approved", and what then runs is the stored arguments,
// never anything the model says afterwards.

export const APPROVAL_TTL_MS = 10 * 60_000

export interface Approval {
  id: string
  userId: string
  tool: string
  args: Record<string, unknown>
  summary: string
  costGd: number
  status: 'pending' | 'approved' | 'cancelled'
  /** The saved reply once the approved action has finished. */
  result: unknown
  createdAt: number
}

function toApproval(r: Record<string, unknown>): Approval {
  return {
    id: String(r.id),
    userId: String(r.user_id),
    tool: String(r.tool),
    args: JSON.parse(String(r.args)) as Record<string, unknown>,
    summary: String(r.summary),
    costGd: Number(r.cost_gd),
    status: r.status as Approval['status'],
    result: r.result ? JSON.parse(String(r.result)) : null,
    createdAt: Number(r.created_at),
  }
}

/** Store a validated action for the user to review. One request waits at a time. */
export async function createApproval(userId: string, input: { tool: string; args: Record<string, unknown>; summary: string; costGd: number }): Promise<Approval> {
  const id = randomUUID()
  await cancelPendingApprovals(userId)
  await run('INSERT INTO approvals (id, user_id, tool, args, summary, cost_gd, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', [
    id,
    userId,
    input.tool,
    JSON.stringify(input.args),
    input.summary,
    input.costGd,
    Date.now(),
  ])
  return (await getApproval(userId, id))!
}

export async function getApproval(userId: string, id: string): Promise<Approval | null> {
  const row = (await run('SELECT * FROM approvals WHERE id = ? AND user_id = ?', [id, userId])).rows[0]
  return row ? toApproval(row) : null
}

/**
 * The request still open for this user, if it has not expired: one waiting for their
 * answer, or one they approved whose action was interrupted and can be resumed.
 */
export async function pendingApproval(userId: string): Promise<Approval | null> {
  const row = (await run("SELECT * FROM approvals WHERE user_id = ? AND (status = 'pending' OR (status = 'approved' AND result IS NULL)) AND created_at > ? ORDER BY created_at DESC LIMIT 1", [userId, Date.now() - APPROVAL_TTL_MS])).rows[0]
  return row ? toApproval(row) : null
}

export async function cancelPendingApprovals(userId: string) {
  await run("UPDATE approvals SET status = 'cancelled', decided_at = ? WHERE user_id = ? AND status = 'pending'", [Date.now(), userId])
}

export async function cancelApproval(id: string) {
  await run("UPDATE approvals SET status = 'cancelled', decided_at = ? WHERE id = ? AND status = 'pending'", [Date.now(), id])
}

/** Record the user's yes. False if it was no longer pending or has expired. */
export async function approve(id: string): Promise<boolean> {
  const r = await run("UPDATE approvals SET status = 'approved', decided_at = ? WHERE id = ? AND status = 'pending' AND created_at > ?", [Date.now(), id, Date.now() - APPROVAL_TTL_MS])
  return r.rowsAffected > 0
}

export async function finishApproval(id: string, result: unknown) {
  await run("UPDATE approvals SET result = ? WHERE id = ? AND status = 'approved'", [JSON.stringify(result), id])
}
