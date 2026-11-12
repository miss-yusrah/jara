import { serverConfig } from '../env'
import { formatEther } from 'viem'
import { describeAction, payBill, prepareBill } from '../bills'
import { formatNgn } from '../catalog'
import { runDaily } from '../daily'
import { AI_TOOLS } from '../ai-tools'
import { getJars, jarDueAt, moveToJar, snapshot } from '../jars'
import { collectRewards } from '../rewards'
import { JAR_INFO, isBillKind, getUserById, listConnectedUsers, logActivity, updateUser, type User } from '../users'

// The agent's own work loop. Runs on a schedule (cron) without the user asking:
//   SAVE     claim today's G$ UBI and share it across the jars
//   PAY      top up jars that are due soon, pay bills on their due date
//   REWARDS  find and collect G$ rewards the user qualifies for
//   AI       keep the AI jar funded so G$ pays for the user's AI helpers
// Then it sends one quiet summary. G$ is what moves at every step.

export type Lane = 'save' | 'pay' | 'rewards' | 'ai'
export interface AgentStep {
  lane: Lane
  text: string
}

const DAY = 86_400_000

export async function runAgent(userId: string, opts: { force?: boolean } = {}): Promise<{ steps: AgentStep[]; message: string }> {
  let user = (await getUserById(userId))!
  const steps: AgentStep[] = []

  // SAVE (+ pay-when-full for jars without a cadence)
  const daily = await runDaily(user, opts)
  if (daily.claimed > 0n) steps.push({ lane: 'save', text: `Claimed G$ ${Number(formatEther(daily.claimed)).toLocaleString('en-US', { maximumFractionDigits: 0 })} and shared it across your jars` })
  if (daily.reward > 0n) steps.push({ lane: 'rewards', text: `${daily.streak}-day streak bonus collected` })
  for (const p of daily.paid) steps.push({ lane: 'pay', text: `Paid ${p}` })

  // PAY: bills with a known cadence
  user = (await getUserById(userId))!
  for (const jar of serverConfig().billsLive ? await getJars(user.id) : []) {
    if (!isBillKind(jar.kind) || !jar.everyDays) continue
    const kind = jar.kind
    const due = jarDueAt(jar)
    const view = (await snapshot(user)).jars.find((j) => j.kind === jar.kind)!
    const label = JAR_INFO[jar.kind].label
    const dueSoon = due === null || due - Date.now() <= 2 * DAY

    if (dueSoon && view.balanceNgn < jar.targetNgn) {
      const { movedGd } = await moveToJar(user, jar.kind, jar.targetNgn - view.balanceNgn)
      if (movedGd > 0) steps.push({ lane: 'pay', text: `${label} is due ${due ? 'soon' : 'now'} — moved G$ ${Math.round(movedGd).toLocaleString()} into it` })
      else steps.push({ lane: 'pay', text: `${label} is due soon but your jars are short. I’ll keep saving.` })
    }

    const payNow = due === null || due - Date.now() <= DAY
    if (jar.autoPay && payNow) {
      const fresh = (await snapshot(user)).jars.find((j) => j.kind === jar.kind)!
      if (fresh.balanceNgn >= jar.targetNgn && jar.targetNgn > 0) {
        const prepared = await prepareBill(user, { kind, amountNgn: jar.targetNgn })
        if ('error' in prepared) {
          steps.push({ lane: 'pay', text: `Couldn’t pay ${label}: ${prepared.error}` })
        } else {
          const res = await payBill(user, prepared.action)
          steps.push({ lane: 'pay', text: res.ok ? `Paid ${describeAction(prepared.action)}${res.token ? ` · token ${res.token}` : ''}` : `${label}: ${res.message}` })
        }
      }
    }
  }

  // REWARDS
  user = (await getUserById(userId))!
  for (const r of await collectRewards(user)) steps.push({ lane: 'rewards', text: `Found a reward: ${r.title} (+G$ ${r.amountGd.toLocaleString()})` })

  // AI: tell the user what their AI jar can now pay for (only when today's claim topped it up)
  if (daily.claimed > 0n) {
    const ai = (await snapshot(user)).jars.find((j) => j.kind === 'ai')
    if (ai && ai.balanceGd >= AI_TOOLS.brainstorm.priceGd) {
      const briefs = Math.floor(ai.balanceGd / AI_TOOLS.research.priceGd)
      steps.push({
        lane: 'ai',
        text: briefs > 0 ? `AI jar now covers ${briefs} research brief${briefs > 1 ? 's' : ''} (G$ ${Math.floor(ai.balanceGd).toLocaleString()})` : `AI jar can pay for a brainstorm (G$ ${Math.floor(ai.balanceGd).toLocaleString()})`,
      })
    }
  }

  await updateUser(user.id, { lastRunAt: Date.now() })
  if (steps.length) {
    await logActivity(user.id, { type: 'agent', title: `Jara did ${steps.length} thing${steps.length > 1 ? 's' : ''} for you`, detail: steps.map((s) => s.text).join(' · ').slice(0, 400) })
  }

  const snap = await snapshot(user)
  const jars = snap.jars.map((j) => `${JAR_INFO[j.kind].label} ${j.pct}%`).join(' · ')
  const message = steps.length
    ? `Here’s what I handled for you:\n${steps.map((s) => `• ${s.text}`).join('\n')}\n\nJars: ${jars} (${formatNgn(Math.floor(snap.totalGd * snap.ngnPerGd))} saved)`
    : `All quiet — nothing needed doing. Jars: ${jars}`
  return { steps, message }
}

export async function runAgentForAll(notify: (user: User, text: string) => Promise<void>) {
  const results: { userId: string; ok: boolean; steps?: number; error?: string }[] = []
  for (const user of await listConnectedUsers()) {
    try {
      const r = await runAgent(user.id)
      if (r.steps.length) await notify(user, r.message)
      results.push({ userId: user.id, ok: true, steps: r.steps.length })
    } catch (err) {
      console.error('[agent] run failed for', user.id, err)
      results.push({ userId: user.id, ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return results
}
