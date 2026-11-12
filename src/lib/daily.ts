import { formatEther, parseEther } from 'viem'
import { checkAutoPay } from './auto-pay'
import { GasLowError, claimUbi, sendGdFromTreasury } from './chain'
import { atomic, run } from './db'
import { gdForCeloFee } from './price'
import { authorizedUser } from './wallet-authorization'
import { forwardToOwner, spendMode } from './spend'
import { serverConfig } from './env'
import { snapshot, syncJars, withUserLock } from './jars'
import { listConnectedUsers, logActivity, updateUser, type User } from './users'
import { agentKey } from './wallets'
import { claimViaContract, rewardDestination } from './claimers'

export function lagosDay(offsetDays = 0): string {
  const d = new Date(Date.now() + offsetDays * 86_400_000)
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos' }).format(d) // YYYY-MM-DD
}

const gd = (wei: bigint) => `G$ ${Number(formatEther(wei)).toLocaleString('en-US', { maximumFractionDigits: 0 })}`

export interface DailyResult {
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
    let claimed = 0n
    let reward = 0n
    let streak = user.streak
    const lines: string[] = []

    await withUserLock(user.id, async () => {
      if (user.lastClaimDay !== today) {
        let result: Awaited<ReturnType<typeof claimUbi>> = null
        let gasLow = false
        let walletMode = false
        try {
          // Wallet mode: Jara fronts the CELO fee and takes it back from the claimed G$ (shown on the claim).
          walletMode = !user.claimerActive && (await spendMode(user)) === 'wallet'
          result = user.claimerActive
            ? await claimViaContract(user, `keyless-claim:${user.id}:${today}`)
            : await claimUbi(await agentKey(user), { sponsor: walletMode, operationId: `claim:${user.id}:${today}` })

        } catch (err) {
          if (!(err instanceof GasLowError)) throw err
          gasLow = true
        }
        if (gasLow) {
          // Leave lastClaimDay alone so the next run claims as soon as there's gas. Tell them once a day.
          const told = await run("SELECT 1 FROM activity WHERE user_id = ? AND title LIKE 'Couldn%claim%gas%' AND created_at > ? LIMIT 1", [user.id, Date.now() - 20 * 3_600_000])
          if (told.rows.length === 0) {
            await logActivity(user.id, { type: 'agent', status: 'failed', title: 'Couldn’t claim today: add gas', detail: 'Your Jara wallet needs a little CELO for the network fee. Open your profile and tap “Add gas”.' })
            lines.push('⛽ I couldn’t claim your G$ today: your Jara wallet needs a little CELO for the network fee. Open your profile in the app and tap “Add gas”.')
          }
        } else if (result) {
          claimed = result.amount
          streak = user.lastClaimDay === lagosDay(-1) ? user.streak + 1 : user.lastClaimDay === today ? user.streak : 1
          const feeGd = walletMode ? await gdForCeloFee(result.feeWei) : 0n
          await atomic(async (tx) => {
            await tx.execute({ sql: 'UPDATE users SET streak = ?, last_claim_day = ? WHERE id = ?', args: [streak, today, user.id] })
            const logged = await tx.execute({ sql: `INSERT OR IGNORE INTO activity(user_id, type, amount_wei, tx_hash, title, detail, operation_id, created_at) VALUES (?, 'claim', ?, ?, ?, ?, ?, ?)`, args: [user.id, String(claimed), result!.hash, `Claimed ${gd(claimed)} UBI`, feeGd > 0n ? `Celo network fee ${gd(feeGd)}, repaid from your claimed G$` : null, `claim:${user.id}:${today}`, Date.now()] })
            // Only the first time this claim is recorded, so a retried run never charges the fee twice.
            if (logged.rowsAffected && feeGd > 0n) {
              const row = (await tx.execute({ sql: 'SELECT gas_owed_wei FROM users WHERE id = ?', args: [user.id] })).rows[0]
              await tx.execute({ sql: 'UPDATE users SET gas_owed_wei = ? WHERE id = ?', args: [String(BigInt(String(row?.gas_owed_wei ?? '0')) + feeGd), user.id] })
            }
          })
          lines.push(`☀️ Claimed ${gd(claimed)} for you today.`)

        } else {
          await updateUser(user.id, { lastClaimDay: today })
        }
      }
      const { streakDays, streakRewardGd } = serverConfig().rewards
      if (streakDays > 0 && streak > 0 && streak % streakDays === 0 && streakRewardGd > 0 && (await run('SELECT 1 FROM activity WHERE operation_id = ?', [`claim:${user.id}:${today}`])).rows.length) {
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
      const forwarded = await forwardToOwner(user, `${today}:claim`)
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
    return { claimed, reward, streak, paid, message: lines.join('\n') }
  })
}

export async function runDailyForAll(notify: (user: User, text: string) => Promise<void>) {
  const users = await listConnectedUsers()
  const results: { userId: string; ok: boolean; error?: string }[] = []
  for (const user of users) {
    try {
      const r = await runDaily(user)
      if (r.claimed > 0n || r.paid.length) await notify(user, r.message)
      results.push({ userId: user.id, ok: true })
    } catch (err) {
      console.error('[daily] failed for', user.id, err)
      results.push({ userId: user.id, ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return results
}
