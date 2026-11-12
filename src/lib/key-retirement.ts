import type { Address } from 'viem'
import { hasPendingFunds, withAccountLock } from './account-lock'
import { formatGd, gdBalance, whitelistedRoot } from './chain'
import { run } from './db'
import { serverConfig } from './env'

// Retiring agent wallet keys.
//
// A stored key is only worth protecting while its wallet can still do something. Once a
// wallet is not linked to any GoodDollar identity (it cannot claim), holds no G$ and has
// nothing in flight, its key is deleted here. The account then looks like any account
// created after keyless claims: 'keyless', with no private key anywhere on the server.
//
// Deleting a key cannot be undone, so every check fails closed: an RPC error, a balance, a
// link or a pending transaction all leave the key where it is. Nothing here runs on a
// schedule; an operator asks for the report first and then applies it (api/admin/treasury).

export type KeyDecision = { id: string; wallet: string; retire: boolean; reason: string }

type Row = { id: string; wallet: Address; sealed: string; root: string | null; connected: boolean; claimerActive: boolean }

async function decide(row: Row): Promise<Omit<KeyDecision, 'id' | 'wallet'>> {
  const keep = (reason: string) => ({ retire: false, reason })
  if (row.connected && !row.claimerActive) return keep('Still claims with this wallet: the owner has not upgraded.')
  try {
    if (await whitelistedRoot(row.wallet)) return keep('The wallet is still linked to a GoodDollar identity.')
    const balance = await gdBalance(row.wallet)
    if (balance > 0n) return keep(`The wallet still holds G$ ${formatGd(balance, 2)}. The owner should withdraw it first.`)
  } catch {
    return keep('Could not read the wallet on Celo. Nothing was changed.')
  }
  // Matches the wallet as sender, as a recipient, or inside call data.
  const inFlight = await run("SELECT 1 FROM chain_transactions WHERE status = 'pending' AND (sender = ? OR instr(lower(intent), ?) > 0) LIMIT 1", [row.wallet.toLowerCase(), row.wallet.slice(2).toLowerCase()])
  if (inFlight.rows.length > 0) return keep('A transaction involving this wallet is still pending.')
  if (await hasPendingFunds(row.id, row.root)) return keep('A payment or refund on this account is still pending.')
  return { retire: true, reason: row.claimerActive ? 'Upgraded, and the old wallet is unlinked and empty.' : 'Never linked to an identity, and empty.' }
}

async function retained(id?: string): Promise<Row[]> {
  const where = id ? "agent_key_enc != 'keyless' AND id = ?" : "agent_key_enc != 'keyless'"
  const rows = (await run(`SELECT id, agent_address, agent_key_enc, root_address, connected, claimer_active FROM users WHERE ${where} ORDER BY created_at`, id ? [id] : [])).rows
  return rows.map((r) => ({
    id: String(r.id), wallet: String(r.agent_address) as Address, sealed: String(r.agent_key_enc),
    root: r.root_address ? String(r.root_address) : null, connected: Number(r.connected) === 1, claimerActive: Number(r.claimer_active) === 1,
  }))
}

/**
 * Report which stored wallet keys are no longer needed and, with `apply`, delete them.
 * Without `apply` nothing is written. Safe to repeat.
 */
export async function retireAgentKeys(options: { apply?: boolean } = {}): Promise<{ applied: boolean; retired: number; kept: number; accounts: KeyDecision[] }> {
  if (serverConfig().chain.mode !== 'celo') throw new Error('Wallet keys are only retired on Celo; demo accounts still use theirs.')
  const accounts: KeyDecision[] = []
  for (const listed of await retained()) {
    let decision = await decide(listed)
    if (decision.retire && options.apply) {
      // Decide again under the account lock, on the row as it is now, so a claim or payment
      // that started in between is seen; then swap only that exact stored key.
      decision = await withAccountLock(listed.id, async () => {
        const [row] = await retained(listed.id)
        if (!row) return { retire: true, reason: 'Already retired.' }
        const fresh = await decide(row)
        if (!fresh.retire) return fresh
        const done = await run("UPDATE users SET agent_key_enc = 'keyless' WHERE id = ? AND agent_key_enc = ?", [row.id, row.sealed])
        if (done.rowsAffected !== 1) return { retire: false, reason: 'The stored key changed while it was being checked. Nothing was deleted.' }
        console.log('[custody] retired wallet key', row.id, row.wallet)
        return fresh
      })
    }
    accounts.push({ id: listed.id, wallet: listed.wallet, ...decision })
  }
  const retired = accounts.filter((a) => a.retire).length
  return { applied: Boolean(options.apply), retired, kept: accounts.length - retired, accounts }
}
