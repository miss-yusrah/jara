import { serverConfig } from '../env'
import { formatEther } from 'viem'
import { checkAutoPay } from '../auto-pay'
import { formatNgn } from '../catalog'
import { lagosDay, runDaily } from '../daily'
import { forwardToOwner } from '../spend'
import { AI_TOOLS } from '../ai-tools'
import { getJars, jarDueAt, moveToJar, snapshot, syncJars, withUserLock } from '../jars'
import { collectRewards } from '../rewards'
import { runAgentJobs } from './jobs'
import { JAR_INFO, isBillKind, getUserById, listConnectedUsers, logActivity, updateUser, type User } from '../users'

// The agent's own work loop. Runs on a schedule (cron) without the user asking:
//   SAVE     claim today's G$ UBI and share it across the jars
//   PAY      top up jars that are due soon, pay bills on their due date
//   REWARDS  find and collect G$ rewards the user qualifies for
//   AI       keep the AI jar funded so G$ pays for the user's AI helpers
//   JOBS     daily exam drills, opportunity scout, verification reminders (see jobs.ts)
// Then it sends one quiet summary. G$ is what moves at every step.

export type Lane = 'save' | 'pay' | 'rewards' | 'ai'
export interface AgentStep {
  lane: Lane
  text: string
}

const DAY = 86_400_000

export async function runAgent(
  userId: string,
  opts: { force?: boolean; scheduled?: boolean } = {},
): Promise<{ steps: AgentStep[]; message: string; notices: string[] }> {
  return withUserLock(userId, async () => {
    let user = (await getUserById(userId))!
    const steps: AgentStep[] = []

    // SAVE (+ any eligible auto-pay bills)
    const daily = await runDaily(user, opts)
    if (daily.claimed > 0n) steps.push({ lane: 'save', text: `Claimed G$ ${Number(formatEther(daily.claimed)).toLocaleString('en-US', { maximumFractionDigits: 0 })} and shared it across your jars` })
    if (daily.reward > 0n) steps.push({ lane: 'rewards', text: `${daily.streak}-day streak bonus collected` })
    for (const p of daily.paid) steps.push({ lane: 'pay', text: `Paid ${p}` })

    // PAY: bills with a known cadence
    user = (await getUserById(userId))!
    for (const jar of serverConfig().billsLive ? await getJars(user.id) : []) {
      if (!isBillKind(jar.kind) || !jar.everyDays) continue
      const due = jarDueAt(jar)
      const view = (await snapshot(user)).jars.find((j) => j.kind === jar.kind)!
      const label = JAR_INFO[jar.kind].label
      const dueSoon = due === null || due - Date.now() <= 2 * DAY

      if (dueSoon && view.balanceNgn < jar.targetNgn) {
        const { movedGd } = await moveToJar(user, jar.kind, jar.targetNgn - view.balanceNgn)
        if (movedGd > 0) steps.push({ lane: 'pay', text: `${label} is due ${due ? 'soon' : 'now'} — moved G$ ${Math.round(movedGd).toLocaleString()} into it` })
        else steps.push({ lane: 'pay', text: `${label} is due soon but your jars are short. I’ll keep saving.` })
      }
    }

    // REWARDS
    user = (await getUserById(userId))!
    const found = await collectRewards(user)
    for (const r of found) steps.push({ lane: 'rewards', text: `Found a reward: ${r.title} (+G$ ${r.amountGd.toLocaleString()})` })
    // Rewards are paid to the Jara wallet; pass them on to the person's own wallet too.
    if (found.length && (await forwardToOwner(user, `${lagosDay()}:rewards`))) await syncJars(user)

    // Due-soon top-ups and rewards can also fill a jar.
    for (const payment of await checkAutoPay(user)) {
      steps.push({ lane: 'pay', text: payment.result.ok && !payment.result.pending ? `Paid ${payment.description}${payment.result.token ? ` · token ${payment.result.token}` : ''}` : payment.result.message })
    }

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

    // JOBS: proactive work the user switched on. Each sends its own message.
    const notices: string[] = []
    for (const n of await runAgentJobs((await getUserById(userId))!, { scheduled: opts.scheduled })) {
      steps.push({ lane: n.lane, text: n.text })
      if (n.message) notices.push(n.message)
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
    return { steps, message, notices }
  })
}

export async function runAgentForAll(notify: (user: User, text: string) => Promise<void>) {
  const results: { userId: string; ok: boolean; steps?: number; error?: string }[] = []
  for (const user of await listConnectedUsers()) {
    try {
      const r = await runAgent(user.id, { scheduled: true })
      if (r.steps.length) await notify(user, r.message)
      for (const n of r.notices) await notify(user, n)
      results.push({ userId: user.id, ok: true, steps: r.steps.length })
    } catch (err) {
      console.error('[agent] run failed for', user.id, err)
      results.push({ userId: user.id, ok: false, error: err instanceof Error ? err.message : String(err) })
    }
  }
  return results
}
