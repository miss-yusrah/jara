import { formatEther, parseEther } from 'viem'
import { checkAutoPay } from './auto-pay'
import { GasLowError, claimUbi, sendGdFromTreasury, ubiClaimPeriod } from './chain'
import { atomic, run } from './db'
import { gdForCeloFee } from './price'
import { authorizedUser, WalletLinkError } from './wallet-authorization'
import { forwardToOwner, spendMode } from './spend'
import { serverConfig } from './env'
import { snapshot, syncJars, withUserLock } from './jars'
import { listConnectedUsers, logActivity, type User } from './users'
import { agentKey } from './wallets'
import { claimViaContract, rewardDestination } from './claimers'

export function lagosDay(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000)
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos' }).format(d) // YYYY-MM-DD
}

const gd = (wei: bigint) => `G$ ${Number(formatEther(wei)).toLocaleString('en-US', { maximumFractionDigits: 0 })}`

export interface DailyResult {
  claimStatus: 'claimed' | 'already_claimed' | 'not_available' | 'gas_low'
  claimMessage: string
  claimed: bigint
  reward: bigint
  streak: number
  paid: string[]
  message: string
}

/** Claim today's UBI, fill the jars, pay any auto-pay bills that are ready. */
export async function runDaily(user: User, _opts: { force?: boolean } = {}): Promise<DailyResult> {
  void _opts // Replaying a daily claim is always idempotent, including forced runs.
  return withUserLock(user.id, async () => {
    user = await authorizedUser(user)
    const today = lagosDay()
    const live = serverConfig().chain.mode === 'celo'
    const period = live ? await ubiClaimPeriod() : null
    let recordId = `claim:${user.id}:${period?.id ?? today}`
    let operationId = user.claimerActive ? `keyless-${recordId}` : recordId
    // Finish previously signed claims under their original IDs, including those
    // created by the old calendar-day implementation. Never replace signed bytes.
    if (live) {
      const prefix = user.claimerActive ? `keyless-claim:${user.id}:` : `claim:${user.id}:`
      const saved = (await run(`SELECT c.id FROM chain_transactions c
        WHERE substr(c.id, 1, ?) = ? AND c.status IN ('pending', 'confirmed')
        AND NOT EXISTS (SELECT 1 FROM activity a WHERE a.user_id = ? AND
          (a.operation_id = CASE WHEN c.id LIKE 'keyless-%' THEN substr(c.id, 9) ELSE c.id END
          OR (a.type = 'claim' AND a.tx_hash = c.hash))) ORDER BY c.created_at LIMIT 1`, [prefix.length, prefix, user.id])).rows[0]
      if (saved) {
        operationId = String(saved.id)
        recordId = operationId.startsWith('keyless-') ? operationId.slice(8) : operationId
      }
    }
    const recorded = (await run(
      "SELECT 1 FROM activity WHERE user_id = ? AND operation_id = ? AND type = 'claim' AND status = 'done' AND amount_wei != '0'",
      [user.id, recordId],
    )).rows.length > 0
    const previousClaim = live
      ? (await run("SELECT created_at FROM activity WHERE user_id = ? AND type = 'claim' AND status = 'done' AND amount_wei != '0' ORDER BY created_at DESC LIMIT 1", [user.id])).rows[0]
      : null
    // Older deployments also wrote lastClaimDay for empty entitlement checks.
    // Only confirmed receipts are evidence of a live user's previous claim.
    const previousDay = live
      ? previousClaim
        ? new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos' }).format(new Date(Number(previousClaim.created_at)))
        : null
      : user.lastClaimDay
    let claimStatus: DailyResult['claimStatus'] = 'already_claimed'
    let claimMessage = 'Your G$ for this claim period has already been collected.'
    let claimed = 0n
    let reward = 0n
    let streak = user.streak
    const lines: string[] = []

    await withUserLock(user.id, async () => {
      if (live ? !recorded : user.lastClaimDay !== today) {
        let result: Awaited<ReturnType<typeof claimUbi>> = null
        let gasLow = false
        let walletMode = false
        try {
          // Wallet mode: Jara fronts the CELO fee and takes it back from the claimed G$ (shown on the claim).
          walletMode = !user.claimerActive && (await spendMode(user)) === 'wallet'
          result = user.claimerActive
            ? await claimViaContract(user, operationId)
            : await claimUbi(await agentKey(user), { sponsor: walletMode, operationId })

        } catch (err) {
          if (!(err instanceof GasLowError)) throw err
          gasLow = true
        }
        if (gasLow) {
          claimStatus = 'gas_low'
          claimMessage = 'Your Jara wallet needs a little CELO for the network fee. Open your profile and tap “Add gas”. I’ll retry automatically.'
          // Leave lastClaimDay alone so the next run claims as soon as there's gas. Tell them once a day.
          const told = await run("SELECT 1 FROM activity WHERE user_id = ? AND title LIKE 'Couldn%claim%gas%' AND created_at > ? LIMIT 1", [user.id, Date.now() - 20 * 3_600_000])
          if (told.rows.length === 0) {
            await logActivity(user.id, { type: 'agent', status: 'failed', title: 'Couldn’t claim today: add gas', detail: 'Your Jara wallet needs a little CELO for the network fee. Open your profile and tap “Add gas”.' })
          }
        } else if (result && result.amount > 0n) {
          claimStatus = 'claimed'
          claimed = result.amount
          streak = previousDay === lagosDay(-1) ? user.streak + 1 : previousDay === today ? Math.max(user.streak, 1) : 1
          const feeGd = walletMode ? await gdForCeloFee(result.feeWei) : 0n
          await atomic(async (tx) => {
            await tx.execute({ sql: 'UPDATE users SET streak = ?, last_claim_day = ? WHERE id = ?', args: [streak, today, user.id] })
            const logged = await tx.execute({ sql: `INSERT OR IGNORE INTO activity(user_id, type, amount_wei, tx_hash, title, detail, operation_id, created_at) VALUES (?, 'claim', ?, ?, ?, ?, ?, ?)`, args: [user.id, String(claimed), result!.hash, `Claimed ${gd(claimed)} UBI`, feeGd > 0n ? `Celo network fee ${gd(feeGd)}, repaid from your claimed G$` : null, recordId, Date.now()] })
            // Only the first time this claim is recorded, so a retried run never charges the fee twice.
            if (logged.rowsAffected && feeGd > 0n) {
              const row = (await tx.execute({ sql: 'SELECT gas_owed_wei FROM users WHERE id = ?', args: [user.id] })).rows[0]
              await tx.execute({ sql: 'UPDATE users SET gas_owed_wei = ? WHERE id = ?', args: [String(BigInt(String(row?.gas_owed_wei ?? '0')) + feeGd), user.id] })
            }
          })
          claimMessage = `☀️ Claimed ${gd(claimed)} for you today.`

        } else {
          claimStatus = previousClaim && period && Number(previousClaim.created_at) >= period.startsAt ? 'already_claimed' : 'not_available'
          claimMessage = claimStatus === 'already_claimed'
            ? 'Your G$ for this claim period has already been collected.'
            : 'No G$ is available to claim right now. I’ll check again automatically.'
          // Record a confirmed empty transaction as a check, never a paid claim.
          // This also prevents old empty receipts monopolising recovery forever.
          if (result) await run(`INSERT OR IGNORE INTO activity(user_id, type, tx_hash, title, operation_id, created_at) VALUES (?, 'agent', ?, 'Claim check completed: no G$ received', ?, ?)`, [user.id, result.hash, recordId, Date.now()])
        }
      }
      lines.push(claimMessage)
      const { streakDays, streakRewardGd } = serverConfig().rewards
      const todayStart = Date.parse(`${today}T00:00:00+01:00`)
      if (streakDays > 0 && streak > 0 && streak % streakDays === 0 && streakRewardGd > 0 && (await run("SELECT 1 FROM activity WHERE user_id = ? AND type = 'claim' AND status = 'done' AND amount_wei != '0' AND created_at >= ? AND created_at < ? LIMIT 1", [user.id, todayStart, todayStart + 86_400_000])).rows.length) {
        const id = `streak:${user.id}:${today}`
        const seen = await run('SELECT 1 FROM activity WHERE operation_id = ?', [id])
        if (!seen.rows.length) {
          try {
            const amount = parseEther(String(streakRewardGd))
            const hash = await sendGdFromTreasury(await rewardDestination(user, id), amount, id)
            await run(`INSERT OR IGNORE INTO activity(user_id, type, amount_wei, tx_hash, title, operation_id, created_at) VALUES (?, 'reward', ?, ?, ?, ?, ?)`, [user.id, String(amount), hash, `${streak}-day streak bonus`, id, Date.now()])
            reward = amount
          } catch (err) { console.warn('[daily] reward awaiting confirmation', err) }
        }
      }
      // The claim (and anything already sitting there) goes on to the person's own wallet.
      const forwarded = await forwardToOwner(user, `${period?.id ?? today}:claim`)
      if (forwarded && claimed > 0n) lines.push('📤 It’s in your own wallet now.')
      await syncJars(user)
    })

    const paid: string[] = []
    for (const payment of await checkAutoPay(user)) {
      if (payment.result.ok && !payment.result.pending) {
        paid.push(`${payment.description}${payment.result.token ? ` · token ${payment.result.token}` : ''}`)
        lines.push(payment.result.message)
      }
    }

    const snap = await snapshot(user)
    lines.push(snap.jars.map((j) => `${j.emoji} ${j.label} ${j.pct}%`).join('  ·  '))
    return { claimed, reward, streak, paid, message: lines.join('\n'), claimStatus, claimMessage }
  })
}

export async function runDailyForAll(notify: (user: User, text: string) => Promise<void>) {
  const users = await listConnectedUsers()
  const results: { userId: string; ok: boolean; claimStatus?: DailyResult['claimStatus'] | 'reconnect'; error?: string }[] = []
  for (const user of users) {
    try {
      const r = await runDaily(user)
      if (r.claimed > 0n || r.paid.length) await notify(user, r.message)
      results.push({ userId: user.id, ok: r.claimStatus !== 'gas_low', claimStatus: r.claimStatus })
    } catch (err) {
      console.error('[daily] failed for', user.id, err instanceof Error ? err.name : 'UnknownError')
      results.push({ userId: user.id, ok: false, claimStatus: err instanceof WalletLinkError ? 'reconnect' : undefined, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return results
}
