import { formatEther, parseEther } from 'viem'
import { describeAction, payBill, prepareBill } from './bills'
import { claimUbi, sendGdFromTreasury } from './chain'
import { serverConfig } from './env'
import { getJars, snapshot, syncJars, withUserLock } from './jars'
import { isBillKind, listConnectedUsers, logActivity, updateUser, type User } from './users'
import { decryptAgentKey } from './wallets'

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
export async function runDaily(user: User, opts: { force?: boolean } = {}): Promise<DailyResult> {
  const today = lagosDay()
  let claimed = 0n
  let reward = 0n
  let streak = user.streak
  const lines: string[] = []

  await withUserLock(user.id, async () => {
    if (user.lastClaimDay !== today || opts.force) {
      const result = await claimUbi(decryptAgentKey(user.agentKeyEnc))
      if (result) {
        claimed = result.amount
        streak = user.lastClaimDay === lagosDay(-1) ? user.streak + 1 : user.lastClaimDay === today ? user.streak : 1
        await updateUser(user.id, { streak, lastClaimDay: today })
        await logActivity(user.id, { type: 'claim', amountWei: claimed.toString(), txHash: result.hash, title: `Claimed ${gd(claimed)} UBI` })
        lines.push(`☀️ Claimed ${gd(claimed)} for you today.`)

        const { streakDays, streakRewardGd } = serverConfig().rewards
        if (streakDays > 0 && streak % streakDays === 0 && streakRewardGd > 0) {
          try {
            reward = parseEther(String(streakRewardGd))
            const hash = await sendGdFromTreasury(user.agentAddress, reward)
            await logActivity(user.id, { type: 'reward', amountWei: reward.toString(), txHash: hash, title: `${streak}-day streak bonus ${gd(reward)} 🔥` })
            lines.push(`🔥 ${streak}-day streak! Bonus ${gd(reward)} added.`)
          } catch (err) {
            reward = 0n
            console.error('[daily] streak reward failed', err)
          }
        }
      } else {
        await updateUser(user.id, { lastClaimDay: today })
      }
    }
    await syncJars(user)
  })

  // Auto-pay jars that reached their target.
  const paid: string[] = []
  for (const jar of await getJars(user.id)) {
    // Jars with a known cadence are paid on their due date by the agent routine instead.
    if (!isBillKind(jar.kind) || !jar.autoPay || jar.everyDays) continue
    const view = (await snapshot(user)).jars.find((j) => j.kind === jar.kind)!
    if (view.balanceNgn < jar.targetNgn || jar.targetNgn <= 0) continue
    const prepared = await prepareBill(user, { kind: jar.kind, amountNgn: jar.targetNgn })
    if ('error' in prepared) continue
    const res = await payBill(user, prepared.action)
    if (res.ok) {
      paid.push(describeAction(prepared.action))
      lines.push(res.message)
    }
  }

  const snap = await snapshot(user)
  lines.push(snap.jars.map((j) => `${j.emoji} ${j.label} ${j.pct}%`).join('  ·  '))
  return { claimed, reward, streak, paid, message: lines.join('\n') }
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
