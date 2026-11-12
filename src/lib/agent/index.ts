import { AsyncLocalStorage } from 'node:async_hooks'
import { moneyRequest } from '../money-request'
import { formatEther } from 'viem'
import { describeAction, payBill, prepareBill } from '../bills'
import { DISCO_INFO, NETWORK_INFO, formatNgn, formatPhone, isDisco, isNetwork, normalizePhone, detectNetwork } from '../catalog'
import { run } from '../db'
import { serverConfig, testNumbersAllowed } from '../env'
import { getJars, moveToJar, snapshot, updateJar, withUserLock, type Snapshot } from '../jars'
import { runDaily } from '../daily'
import { JAR_INFO, getUserById, isBillKind, isJarKind, listActivity, updateUser, type JarKind, type PendingAction, type User } from '../users'
import { approve, cancelApproval, cancelPendingApprovals, createApproval, finishApproval, getApproval, pendingApproval, type Approval } from './approvals'
import { chat, llmReachable, type ChatMessage, type ToolDef } from './llm'
import { directIntent, fallbackIntent, type Intent } from './fallback'
import { runAgent } from './routine'
import { AI_TOOLS, isAiTool, runAiTool } from '../ai-tools'
import { rewardProgress } from '../rewards'
import { DRILL_PRICE_GD, EXAMS, SCOUT_PRICE_GD, daysUntil, examDrill, getJobs, isExam, opportunityScout, parseSubjects, saveJobs, saveToChat, type Exam } from './jobs'

/** What the user is asked to confirm. Nothing behind it has run yet. */
export interface ConfirmCard {
  id: string
  summary: string
  gd: number
  /** Card heading and confirm-button label; bills default to "Ready to pay" / "Pay it". */
  title?: string
  action?: string
}

export interface AgentReply {
  text: string
  /** Set when a bill, or an action the assistant asked for, is waiting for the user to tap Confirm. */
  confirm?: ConfirmCard
  explorerUrl?: string
  /** Extra messages to deliver after the reply (e.g. the first exam drill). */
  extra?: string[]
  engine: 'antseed' | 'llm' | 'rules'
}

// Consent is the whole message being an unambiguous yes. A new instruction that merely
// starts with "ok", "pay" or "send" is not approval of whatever happens to be waiting.
const AFFIRM = 'y|yes|yeah|yep|yup|ok|okay|confirm|approve|go ahead|go|oya|do it|sure|pay it|pay|send it|send'
const YES = new RegExp(`^(?:${AFFIRM})(?:[\\s,.!]+(?:${AFFIRM}|please|pls|abeg|o|now|jara))*[\\s.!]*$`, 'i')
// Likewise a bare no cancels what is waiting; "stop the scholarship search" is a new instruction.
const NO = /^(?:n|no|nope|cancel|stop|abeg no|leave it)(?:[\s,.!]+(?:please|pls|abeg|o|jara|it|that|thanks|thank you))*[\s.!]*$/i
const PENDING_TTL = 10 * 60_000

const TOOLS: ToolDef[] = [
  {
    type: 'function',
    function: {
      name: 'get_jars',
      description: "Current jar balances (G$ and naira value), targets, saved phone/meter details and spare (unallocated) balance.",
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_bill',
      description:
        'Prepare a bill payment. It is NOT paid yet: the user must confirm. Use for airtime, data or light (electricity). If phone/meter is omitted the saved jar details are used.',
      parameters: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: ['airtime', 'data', 'light'] },
          amount_ngn: { type: 'number', description: 'Naira amount. For data, the max to spend.' },
          phone: { type: 'string', description: 'Nigerian phone number, if given' },
          network: { type: 'string', enum: ['mtn', 'airtel', 'glo', '9mobile'] },
          plan: { type: 'string', description: 'Data size if mentioned, e.g. "1GB"' },
          for_whom: { type: 'string', description: 'Who it is for, e.g. "mama"' },
        },
        required: ['kind'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'move_to_jar',
      description: 'Ask to move naira-worth of spare (unallocated) G$ into a jar. It does NOT happen yet: the system shows the user a confirmation and only moves the money after they approve.',
      parameters: {
        type: 'object',
        properties: { jar: { type: 'string', enum: ['light', 'data', 'airtime'] }, amount_ngn: { type: 'number' } },
        required: ['jar', 'amount_ngn'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_jar',
      description: 'Ask to change a jar: savings target in naira, auto-pay on/off, or the phone number/network it pays. It is NOT changed yet: the system shows the user exactly what will change and applies it only after they approve. (Switching auto-pay off applies immediately.)',
      parameters: {
        type: 'object',
        properties: {
          jar: { type: 'string', enum: ['light', 'data', 'airtime'] },
          target_ngn: { type: 'number' },
          auto_pay: { type: 'boolean' },
          phone: { type: 'string' },
          network: { type: 'string', enum: ['mtn', 'airtel', 'glo', '9mobile'] },
        },
        required: ['jar'],
      },
    },
  },
  {
    type: 'function',
    function: { name: 'claim_now', description: "Claim today's G$ UBI into the jars now.", parameters: { type: 'object', properties: {} } },
  },
  {
    type: 'function',
    function: {
      name: 'ai_helpers',
      description: 'List the AI helpers the user can pay for with G$ (research, assignment help, brainstorm, exam practice, CV, opportunities, side-hustle plan, content) and their prices.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'use_ai_helper',
      description:
        'Ask to run an AI helper, paid at its G$ price from the AI jar. Nothing runs and nothing is charged yet: the system shows the user the helper, their request and the price, and runs it only after they approve. Only call when the user clearly asked for it.',
      parameters: {
        type: 'object',
        properties: { tool: { type: 'string', enum: Object.keys(AI_TOOLS) }, input: { type: 'string', description: 'The topic, question or details' } },
        required: ['tool', 'input'],
      },
    },
  },
  {
    type: 'function',
    function: { name: 'my_rewards', description: 'G$ rewards earned so far and what the user is close to earning.', parameters: { type: 'object', properties: {} } },
  },
  {
    type: 'function',
    function: {
      name: 'run_agent',
      description: 'Do a full check-in now: claim G$, fill jars, pay due bills, collect rewards, find work.',
      parameters: { type: 'object', properties: {} },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_exam_prep',
      description: `Switch daily exam prep on or off. Each morning until the exam, Jara prepares a full-screen 20-question practice session, rotating through the subjects, for G$ ${DRILL_PRICE_GD} from the AI jar. Users select answers one at a time and review their score at the end. Switching it on is NOT done yet: the system shows the user the daily price and starts only after they approve; the first session link is then sent right away. Switching it off applies immediately.`,
      parameters: {
        type: 'object',
        properties: {
          on: { type: 'boolean' },
          exam: { type: 'string', enum: [...EXAMS] },
          subjects: { type: 'array', items: { type: 'string' }, description: 'e.g. ["Biology","Chemistry"]' },
          exam_date: { type: 'string', description: 'YYYY-MM-DD' },
        },
        required: ['on'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'set_opportunity_scout',
      description: `Switch the opportunity scout on or off. Every 3 days Jara checks real scholarship, internship and fellowship listings and sends up to 3 that match the user's interests, for G$ ${SCOUT_PRICE_GD} (only charged when something matches). Switching it on is NOT done yet: the system shows the user the price and starts only after they approve. Switching it off applies immediately.`,
      parameters: {
        type: 'object',
        properties: { on: { type: 'boolean' }, interests: { type: 'string', description: 'e.g. "computer science scholarships, tech internships"' } },
        required: ['on'],
      },
    },
  },
  {
    type: 'function',
    function: { name: 'recent_activity', description: 'The last few things Jara did (claims, payments, rewards).', parameters: { type: 'object', properties: {} } },
  },
]

function systemPrompt(user: User, snap: Snapshot): string {
  const jars = snap.jars
    .map((j) => `${j.label}: ${formatNgn(j.balanceNgn)} of ${formatNgn(j.targetNgn)} (${j.pct}%)${j.autoPay ? ', auto-pay on' : ''}`)
    .join('; ')
  return [
    'You are Jara, an AI agent for everyday life in Nigeria. G$ (GoodDollar) drives everything you do.',
    serverConfig().billsLive
      ? 'You quietly handle four jobs: SAVE (claim daily G$ into jars: Light, Data, Airtime, AI), PAY (bills from the jars),'
      : 'You quietly handle three jobs: SAVE (claim daily G$ into jars),',
    'find REWARDS (G$ bonuses), and POWER THEIR AI: the user pays for AI helpers (research, assignment help, brainstorming, exam practice, CV, opportunities, side-hustle plans, content) with G$ from their AI jar.',
    'For assignments, help them understand and plan — never write the whole thing for them.',
    'Talk like a warm Nigerian friend: short, simple English; understand Pidgin and reply in Pidgin if the user writes Pidgin.',
    'Never use crypto jargon (no "wallet", "token", "gas", "blockchain") unless the user asks. Say "your jar" and "G$".',
    serverConfig().billsLive
      ? 'Always use propose_bill for payments — never claim something is paid until the system confirms it.'
      : 'Never bring up bills or bill payments yourself, and never list them among the things you do. Bill payments (airtime, data, electricity) are NOT available yet. Only if the user asks to pay a bill, say in one short line that you can’t pay bills just yet, then offer what you can do: save their G$, collect rewards, or help in Jara AI (research, assignments, exam practice and more). Never discuss jar balances as if a payment is possible.',
    'After propose_bill succeeds, ask the user to confirm in one short line.',
    'You cannot spend G$ or change payment settings yourself. use_ai_helper, set_jar, move_to_jar, set_exam_prep and set_opportunity_scout only create a request: the system shows the user a Confirm button and nothing happens until they tap it. Never say one of these is done, switched on or paid; say it is waiting for them to confirm. Ask for one such thing at a time.',
    `You can also work proactively: daily exam drills until their exam (set_exam_prep, G$ ${DRILL_PRICE_GD} a day) and an opportunity scout for scholarships and internships (set_opportunity_scout, G$ ${SCOUT_PRICE_GD} per match digest). Offer these when someone mentions an exam (WAEC, JAMB, NECO, Post-UTME) or looking for scholarships, internships or jobs. You also warn users before their GoodDollar face check expires.`,
    'Keep replies under 60 words. Use naira amounts.',
    `User: ${user.name ?? 'friend'}. Streak: ${user.streak} days. Jars: ${jars}. Spare: ${formatNgn(snap.freeNgn)}. 1 G$ = ₦${snap.ngnPerGd.toFixed(4)}.`,
  ].join(' ')
}

async function saveMessage(userId: string, role: 'user' | 'assistant', content: string) {
  await run('INSERT INTO messages (user_id, role, content, created_at) VALUES (?, ?, ?, ?)', [userId, role, content, Date.now()])
}

async function history(userId: string): Promise<ChatMessage[]> {
  const r = await run('SELECT role, content FROM messages WHERE user_id = ? ORDER BY id DESC LIMIT 10', [userId])
  return r.rows.reverse().map((x) => ({ role: x.role as 'user' | 'assistant', content: x.content as string }))
}

export async function listMessages(userId: string) {
  const r = await run('SELECT id, role, content, created_at FROM messages WHERE user_id = ? ORDER BY id DESC LIMIT 40', [userId])
  return r.rows.reverse().map((x) => ({ id: Number(x.id), role: x.role as string, content: x.content as string, createdAt: Number(x.created_at) }))
}

// ---------- tool implementations ----------

async function propose(user: User, args: Record<string, unknown>): Promise<{ text: string; confirm?: AgentReply['confirm'] }> {
  if (!isBillKind(args.kind)) return { text: 'error: kind must be airtime, data or light' }
  const fresh = (await getUserById(user.id))!
  if (fresh.pending?.id) {
    const active = (await run('SELECT result FROM money_requests WHERE id = ?', [`${user.id}:bill:${fresh.pending.id}`])).rows[0]
    if (active && !active.result) return { text: 'error: Your previous bill is still processing. Wait for its result before starting another.' }
  }
  const prepared = await prepareBill(user, {
    kind: args.kind,
    amountNgn: Number(args.amount_ngn ?? (args.kind === 'data' ? 20_000 : 0)),
    phone: typeof args.phone === 'string' ? args.phone : undefined,
    network: typeof args.network === 'string' ? args.network : undefined,
    planName: typeof args.plan === 'string' ? args.plan : undefined,
    forWhom: typeof args.for_whom === 'string' ? args.for_whom : undefined,
  })
  if ('error' in prepared) return { text: `error: ${prepared.error}` }
  // One thing waits for a yes at a time, so a plain "yes" can only mean this bill.
  await cancelPendingApprovals(user.id)
  await updateUser(user.id, { pending: prepared.action })
  const gd = Number(formatEther(BigInt(prepared.action.quoteWei!)))
  const summary = describeAction(prepared.action)
  return { text: `ready to confirm: ${summary} costing G$ ${gd.toFixed(0)}`, confirm: { id: prepared.action.id!, summary, gd: Math.ceil(gd) } }
}

// ---------- consent gate ----------
//
// Tools that charge G$ or change how money is paid never run because the model called
// them. `planGatedTool` validates and normalizes the request; unless it only switches
// spending OFF, it is stored as an approval and nothing happens until the user confirms.

type JarChange = { jar: JarKind; target_ngn?: number; auto_pay?: boolean; phone?: string; network?: string }
type GatedPlan =
  | { error: string }
  /** Only reduces spending (auto-pay or a paid job switched off): safe to apply at once. */
  | { immediate: true; args: Record<string, unknown> }
  | { args: Record<string, unknown>; summary: string; gd: number }

const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

async function planGatedTool(user: User, name: string, args: Record<string, unknown>): Promise<GatedPlan | null> {
  switch (name) {
    case 'use_ai_helper': {
      if (!isAiTool(args.tool)) return { error: 'unknown helper' }
      const input = String(args.input ?? '').trim().slice(0, 2000)
      if (input.length < 3) return { error: 'ask the user for the topic or question first' }
      const spec = AI_TOOLS[args.tool]
      return { args: { tool: args.tool, input, priceGd: spec.priceGd }, summary: `${spec.name}: “${clip(input, 90)}”`, gd: spec.priceGd }
    }
    case 'set_jar': {
      if (!isJarKind(args.jar)) return { error: 'unknown jar' }
      const jar = (await getJars(user.id)).find((j) => j.kind === args.jar)!
      const change: JarChange = { jar: args.jar }
      const parts: string[] = []
      if (typeof args.phone === 'string') {
        const phone = normalizePhone(args.phone, testNumbersAllowed())
        if (!phone) return { error: 'invalid phone' }
        change.phone = phone
        change.network = (isNetwork(args.network) ? args.network : detectNetwork(phone)) ?? ''
        parts.push(`pay ${formatPhone(phone)}${isNetwork(change.network) ? ` (${NETWORK_INFO[change.network].label})` : ''}`)
      }
      if (typeof args.target_ngn === 'number' && Number.isFinite(args.target_ngn)) {
        change.target_ngn = Math.round(Math.min(Math.max(args.target_ngn, 0), serverConfig().limits.maxBillNgn))
        parts.push(`set the amount to ${formatNgn(change.target_ngn)}`)
      }
      if (args.auto_pay === false) {
        change.auto_pay = false
        if (!parts.length) return { immediate: true, args: change }
        parts.push('switch auto-pay off')
      } else if (args.auto_pay === true) {
        if (!isBillKind(args.jar)) return { error: 'auto-pay only applies to the light, data and airtime jars' }
        const amount = change.target_ngn ?? jar.targetNgn
        const recipient = args.jar === 'light' ? (jar.details.meterNumber ? `meter ${jar.details.meterNumber}` : null) : (change.phone ?? jar.details.phone) ? formatPhone((change.phone ?? jar.details.phone)!) : null
        if (!recipient) return { error: `the ${args.jar} jar has no ${args.jar === 'light' ? 'meter' : 'phone number'} saved yet; ask the user for it (light meters are set up in the app) before switching auto-pay on` }
        if (amount <= 0) return { error: 'the jar needs an amount (target) before auto-pay can be switched on' }
        change.auto_pay = true
        parts.push(`switch auto-pay ON: ${formatNgn(amount)} to ${recipient} ${jar.everyDays ? `every ${jar.everyDays} days` : 'whenever the jar is full'}, paid without asking each time`)
      }
      if (!parts.length) return { error: 'nothing to change; say what should change (amount, phone number or auto-pay)' }
      const alreadyAuto = jar.autoPay && change.auto_pay === undefined ? ' (auto-pay is on, so this changes what gets paid automatically)' : ''
      return { args: change, summary: `${JAR_INFO[args.jar].label} jar: ${parts.join('; ')}${alreadyAuto}`, gd: 0 }
    }
    case 'move_to_jar': {
      if (!isJarKind(args.jar)) return { error: 'unknown jar' }
      const ngn = Math.round(Number(args.amount_ngn))
      if (!Number.isFinite(ngn) || ngn <= 0) return { error: 'how much should be moved? Give a naira amount' }
      const jar = (await getJars(user.id)).find((j) => j.kind === args.jar)!
      const auto = jar.autoPay ? ' (auto-pay is on for this jar: its bill is paid once the jar is full)' : ''
      return { args: { jar: args.jar, amount_ngn: ngn }, summary: `Move ${formatNgn(ngn)} of your spare G$ into the ${JAR_INFO[args.jar].label} jar${auto}`, gd: 0 }
    }
    case 'set_exam_prep': {
      if (args.on === false) return { immediate: true, args: { on: false } }
      const plan = await planExamPrep(user, { exam: args.exam, subjects: args.subjects, examDate: args.exam_date })
      if ('error' in plan) return plan
      return {
        args: { on: true, exam: plan.exam, subjects: plan.subjects, exam_date: plan.date },
        summary: `Daily ${plan.exam} practice (${plan.subjects.join(', ')}) every morning until ${plan.date}: G$ ${DRILL_PRICE_GD} from your AI jar each day, starting with today’s`,
        gd: DRILL_PRICE_GD,
      }
    }
    case 'set_opportunity_scout': {
      if (args.on === false) return { immediate: true, args: { on: false } }
      const interests = await planScout(user, args.interests)
      if (typeof interests !== 'string') return interests
      return {
        args: { on: true, interests },
        summary: `Opportunity scout for “${clip(interests, 80)}”: checks every 3 days, G$ ${SCOUT_PRICE_GD} from your AI jar each time it finds matches`,
        gd: SCOUT_PRICE_GD,
      }
    }
    default:
      return null
  }
}

async function applyJarChange(user: User, change: JarChange): Promise<string> {
  await updateJar(user.id, change.jar, {
    targetNgn: change.target_ngn,
    autoPay: change.auto_pay,
    details: change.phone ? { phone: change.phone, network: change.network ?? '' } : {},
  })
  return `updated ${change.jar} jar`
}

type ToolOut = {
  confirm?: ConfirmCard
  /** What to say alongside the confirm card. */
  prompt?: string
  extra?: string[]
  /** A charge started but is not confirmed yet; the same request can be retried. */
  unsettled?: boolean
}

const ONE_AT_A_TIME = 'error: something is already waiting for the user to confirm. Ask for one thing at a time.'

/** What the model may trigger. Gated tools stop here and wait for the user. */
async function executeTool(user: User, name: string, args: Record<string, unknown>, out: ToolOut) {
  const plan = await planGatedTool(user, name, args)
  if (!plan) return name === 'propose_bill' && out.confirm ? ONE_AT_A_TIME : runTool(user, name, args, out)
  if ('error' in plan) return `error: ${plan.error}`
  if ('immediate' in plan) return runTool(user, name, plan.args, out)
  if (out.confirm) return ONE_AT_A_TIME
  // A bill that was proposed but never confirmed gives way, so a plain "yes" is unambiguous.
  const fresh = (await getUserById(user.id))!
  if (fresh.pending && !(fresh.pending.id && (await run('SELECT 1 FROM money_requests WHERE id = ?', [`${user.id}:bill:${fresh.pending.id}`])).rows.length)) {
    await updateUser(user.id, { pending: null })
  }
  const approval = await createApproval(user.id, { tool: name, args: plan.args, summary: plan.summary, costGd: plan.gd })
  out.confirm = { id: approval.id, summary: plan.summary, gd: plan.gd, title: 'Needs your OK', action: plan.gd > 0 ? `Approve · G$ ${plan.gd}` : 'Approve' }
  out.prompt = `${plan.summary}.${plan.gd > 0 ? ` That’s G$ ${plan.gd} from your AI jar.` : ''} Tap Approve and I’ll do it. Nothing changes until you do.`
  return `waiting for the user's approval: ${plan.summary}. It has NOT happened and nothing was charged. The user must tap Approve.`
}

/** Runs a tool. Gated tools reach this only with arguments the user approved (or that only switch spending off). */
async function runTool(user: User, name: string, args: Record<string, unknown>, out: ToolOut) {
  switch (name) {
    case 'get_jars':
      return JSON.stringify(await snapshot(user))
    case 'propose_bill': {
      const r = await propose(user, args)
      if (r.confirm) out.confirm = r.confirm
      return r.text
    }
    case 'move_to_jar': {
      if (!isJarKind(args.jar)) return 'error: unknown jar'
      const operation = agentRequestContext.getStore()
      if (!operation) throw new Error('An approved request is required before changing budgets.')
      const r = await moveToJar(user, args.jar, Number(args.amount_ngn), operation)
      return r.movedGd > 0 ? `moved G$ ${r.movedGd.toFixed(0)} into your ${JAR_INFO[args.jar].label} jar` : 'error: there is no spare G$ to move right now'
    }
    case 'set_jar':
      if (!isJarKind(args.jar)) return 'error: unknown jar'
      return applyJarChange(user, args as JarChange)
    case 'claim_now': {
      const fresh = (await getUserById(user.id))!
      if (!fresh.connected) return 'error: user has not connected their GoodDollar account yet; tell them to finish setup in the app'
      const r = await runDaily(fresh)
      return r.claimed > 0n ? r.message : 'already claimed today; next claim tomorrow'
    }
    case 'ai_helpers':
      return JSON.stringify(Object.entries(AI_TOOLS).map(([id, t]) => ({ id, name: t.name, price_gd: t.priceGd, what: t.blurb })))
    case 'use_ai_helper': {
      if (!isAiTool(args.tool)) return 'error: unknown helper'
      // The price the user saw is the price charged.
      if (AI_TOOLS[args.tool].priceGd !== args.priceGd) return 'error: the price of this helper changed. Ask again to see the new price.'
      const fresh = (await getUserById(user.id))!
      const operation = agentRequestContext.getStore()
      if (!operation) throw new Error('An approved request is required before starting paid AI.')
      const r = await runAiTool(fresh, args.tool, String(args.input ?? ''), `${operation}:ai`)
      if (r.pending) out.unsettled = true
      return r.ok ? `${r.demo ? '(demo preview, not charged) ' : `(charged G$ ${r.costGd}) `}${r.output}` : `error: ${r.message}`
    }
    case 'my_rewards':
      return JSON.stringify(await rewardProgress(user))
    case 'run_agent': {
      const fresh = (await getUserById(user.id))!
      if (!fresh.connected) return 'error: user has not connected their GoodDollar account yet'
      const r = await runAgent(user.id)
      return [r.message, ...r.notices].join('\n\n')
    }
    case 'set_exam_prep': {
      if (args.on === false) {
        await saveJobs(user.id, { examOn: false })
        return 'daily exam drills switched off'
      }
      const r = await setExamPrep(user, { exam: args.exam, subjects: args.subjects, examDate: args.exam_date })
      if ('error' in r) return `error: ${r.error}`
      if (r.sent) (out.extra ??= []).push(r.sent)
      return r.text
    }
    case 'set_opportunity_scout': {
      if (args.on === false) {
        await saveJobs(user.id, { scoutOn: false })
        return 'opportunity scout switched off'
      }
      const r = await setScout(user, args.interests)
      if ('error' in r) return `error: ${r.error}`
      if (r.sent) (out.extra ??= []).push(r.sent)
      return r.text
    }
    case 'recent_activity':
      return JSON.stringify((await listActivity(user.id, 6)).map((a) => ({ title: a.title, status: a.status, when: new Date(a.createdAt).toISOString() })))
    default:
      return `error: unknown tool ${name}`
  }
}

// ---------- proactive jobs (shared by chat tools and the web API) ----------

/** Validate exam-prep settings without changing anything. */
async function planExamPrep(
  user: User,
  input: { exam?: unknown; subjects?: unknown; examDate?: unknown },
): Promise<{ error: string } | { exam: Exam; subjects: string[]; date: string; left: number }> {
  const current = await getJobs(user.id)
  const exam = input.exam === undefined ? current.exam : input.exam
  if (!isExam(exam)) return { error: `exam must be one of ${EXAMS.join(', ')}` }
  const subjects = input.subjects === undefined ? current.examSubjects : parseSubjects(input.subjects)
  if (!subjects.length) return { error: 'which subjects? (e.g. Biology, Chemistry)' }
  const date = input.examDate === undefined ? current.examDate : typeof input.examDate === 'string' ? input.examDate : null
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) return { error: 'what date is the exam? (YYYY-MM-DD)' }
  const left = daysUntil(date)
  if (left < 1 || left > 400) return { error: 'the exam date should be in the future, within about a year' }
  return { exam, subjects, date, left }
}

export async function setExamPrep(
  user: User,
  input: { exam?: unknown; subjects?: unknown; examDate?: unknown },
): Promise<{ error: string } | { text: string; sent?: string }> {
  const plan = await planExamPrep(user, input)
  if ('error' in plan) return plan
  const { exam, subjects, date, left } = plan
  const current = await getJobs(user.id)
  const restart = !current.examOn || current.exam !== exam
  await saveJobs(user.id, { examOn: true, exam, examSubjects: subjects, examDate: date, ...(restart ? { examCount: 0, examLastDay: null } : {}) })
  // Send the first drill right away so they see what they signed up for.
  const first = await examDrill((await getUserById(user.id))!, await getJobs(user.id)).catch(() => null)
  const base = `daily ${exam} drills on: ${subjects.join(', ')}, until ${date} (${left} days), G$ ${DRILL_PRICE_GD} each`
  return { text: first ? `${base}. ${first.text}` : base, sent: first?.message }
}

/** The scout's interests, validated, or why they are missing. */
async function planScout(user: User, interests: unknown): Promise<{ error: string } | string> {
  const current = await getJobs(user.id)
  const text = typeof interests === 'string' ? interests.trim().replace(/\s+/g, ' ').slice(0, 200) : current.scoutInterests
  if (!text || text.length < 3) return { error: 'what kind of opportunities? (e.g. engineering scholarships, tech internships)' }
  return text
}

export async function setScout(user: User, interests: unknown): Promise<{ error: string } | { text: string; sent?: string }> {
  const text = await planScout(user, interests)
  if (typeof text !== 'string') return text
  await saveJobs(user.id, { scoutOn: true, scoutInterests: text, scoutLastAt: null })
  const first = await opportunityScout((await getUserById(user.id))!, await getJobs(user.id)).catch(() => null)
  const base = `opportunity scout on for "${text}": checks every 3 days, G$ ${SCOUT_PRICE_GD} only when something matches`
  return { text: first ? `${base}. ${first.text}` : `${base}. Nothing new matched today; I'll keep looking.`, sent: first?.message }
}

// ---------- main entry ----------

/** The durable operation a tool call belongs to: a saved chat message, or an approved request. */
const agentRequestContext = new AsyncLocalStorage<string>()

export async function handleMessage(userId: string, text: string, requestId: string): Promise<AgentReply> {
  return withUserLock(userId, async () => {
    const request = await moneyRequest(userId, `message:${requestId}`, { text: text.trim() })
    if (request.result) return request.result as AgentReply
    return agentRequestContext.run(`message:${requestId}`, async () => {
      const user = (await getUserById(userId))!
      const clean = text.trim()
      await saveMessage(user.id, 'user', clean)
      const reply = await respond(user, clean)
      await saveMessage(user.id, 'assistant', reply.text)
      for (const m of reply.extra ?? []) await saveToChat(user.id, m)
      return request.finish(reply)
    })
  })
}

/** Confirm or cancel the waiting bill (buttons call this directly). */
export async function resolvePending(userId: string, accept: boolean, expectedId?: string): Promise<AgentReply> {
  return withUserLock(userId, async () => {
    const user = (await getUserById(userId))!
    // A button names the exact request it was shown for; a typed yes/no answers the one waiting.
    // A typed answer goes to a request still awaiting one; an interrupted, already-approved
    // request is resumed that way only when no bill is waiting.
    const approval = expectedId ? await getApproval(userId, expectedId) : await pendingApproval(userId)
    if (approval && (expectedId || approval.status === 'pending' || !user.pending)) return resolveApproval(user, approval, accept)
    const pending = user.pending
    if (expectedId && pending?.id !== expectedId) {
      const prior = (await run('SELECT result FROM money_requests WHERE id = ? AND user_id = ?', [`${userId}:bill:${expectedId}`, userId])).rows[0]
      if (prior?.result) return { text: JSON.parse(String(prior.result)).message, engine: 'rules' }
      return { text: 'This confirmation does not match your current bill. Review the current bill before paying.', engine: 'rules' }
    }
    if (!pending) {
      // Usually a second tap while the first one was still paying: say what happened to it.
      const recent = (await run("SELECT title, status, detail FROM activity WHERE user_id = ? AND type = 'pay' AND created_at > ? ORDER BY id DESC LIMIT 1", [user.id, Date.now() - 10 * 60_000])).rows[0]
      if (recent) {
        const title = String(recent.title)
        const text =
          recent.status === 'done'
            ? `Already done ✅ ${title}.${recent.detail && String(recent.detail).startsWith('Token') ? `\n\n🔑 ${recent.detail}` : ''}`
            : recent.status === 'failed'
              ? `${title} — it didn’t go through. Check its activity details for the payment or refund status.`
              : `${title.replace(/^Paying /, 'Your ')} is still processing. I’ll message you as soon as it’s confirmed.`
        return { text, engine: 'rules' }
      }
      return { text: 'That request expired. Tell me again what to pay.', engine: 'rules' }
    }
    if (Date.now() - pending.createdAt > PENDING_TTL && !(pending.id && (await run('SELECT 1 FROM money_requests WHERE id = ?', [`${user.id}:bill:${pending.id}`])).rows.length)) {
      return { text: 'That request expired. Tell me again what to pay.', engine: 'rules' }
    }
    if (!accept) {
      const existing = pending.id ? (await run('SELECT 1 FROM money_requests WHERE id = ?', [`${user.id}:bill:${pending.id}`])).rows.length > 0 : false
      if (existing) return { text: 'This payment has already started. Its existing result will be checked; it cannot be cancelled here.', engine: 'rules' }
      await updateUser(user.id, { pending: null })
      return { text: 'No wahala, cancelled. Nothing was paid.', engine: 'rules' }
    }
    const res = await payBill(user, pending)
    if (!res.pending) await updateUser(user.id, { pending: null })
    return { text: res.message, explorerUrl: res.explorerUrl, engine: 'rules' }
  })
}

/** The user's answer to an assistant request. Runs exactly what was stored and shown, once. */
async function resolveApproval(user: User, approval: Approval, accept: boolean): Promise<AgentReply> {
  if (approval.result) return approval.result as AgentReply
  if (approval.status === 'cancelled') return { text: 'That request was cancelled, so nothing was changed or charged. Ask me again if you still want it.', engine: 'rules' }
  if (approval.status === 'pending') {
    if (!accept) {
      await cancelApproval(approval.id)
      return { text: 'No wahala, cancelled. Nothing was changed or charged.', engine: 'rules' }
    }
    if (!(await approve(approval.id))) {
      await cancelApproval(approval.id)
      return { text: 'That request expired, so nothing was changed or charged. Ask me again and I’ll set it up.', engine: 'rules' }
    }
  } else if (!accept) {
    return { text: 'You already approved this and it has started, so it can’t be cancelled here.', engine: 'rules' }
  }
  // Approved (now, or earlier and interrupted): the same durable operation ID makes a retry safe.
  const out: ToolOut = {}
  const result = await agentRequestContext.run(`approval:${approval.id}`, () => runTool(user, approval.tool, approval.args, out))
  const failed = result.startsWith('error: ')
  const text = failed ? result.slice('error: '.length) : approval.tool === 'set_jar' ? `Done ✅ ${approval.summary}.` : approval.tool === 'use_ai_helper' ? result : `Done ✅ ${result.charAt(0).toUpperCase()}${result.slice(1)}`
  const reply: AgentReply = { text, extra: out.extra, engine: 'rules' }
  // An unconfirmed charge keeps the approval open so the same button re-checks that same payment.
  if (!out.unsettled) await finishApproval(approval.id, { text, engine: 'rules' })
  return reply
}

/** The bill or assistant request waiting for this user's answer, as shown on the confirm card. */
export async function pendingConfirm(user: User): Promise<ConfirmCard | null> {
  const approval = await pendingApproval(user.id)
  if (approval && (approval.status === 'pending' || !user.pending?.id)) {
    return { id: approval.id, summary: approval.summary, gd: approval.costGd, title: 'Needs your OK', action: approval.costGd > 0 ? `Approve · G$ ${approval.costGd}` : 'Approve' }
  }
  if (!user.pending?.id) return null
  return { id: user.pending.id, summary: describeAction(user.pending), gd: user.pending.quoteWei ? Math.ceil(Number(formatEther(BigInt(user.pending.quoteWei)))) : 0 }
}

async function respond(user: User, text: string): Promise<AgentReply> {
  if (YES.test(text) || NO.test(text)) {
    if (user.pending || (await pendingApproval(user.id))) return resolvePending(user.id, YES.test(text))
  }

  if (/^(?:hi|hello|hey|good morning|good afternoon|good evening)(?:\s+jara)?[!.]*$/i.test(text)) {
    return { text: `Hi${user.name ? ` ${user.name}` : ''}! How can I help you today?`, engine: 'rules' }
  }
  const direct = directIntent(text)
  if (direct) return rulesRespond(user, text, undefined, direct)

  if (!(await llmReachable())) return rulesRespond(user, text)
  // Displaying context needs one fresh read. Payment tools still synchronize
  // and validate balances themselves immediately before reserving any money.
  const snap = await snapshot(user)
  try {
    return await llmRespond(user, text, snap)
  } catch (err) {
    if (!serverConfig().llm.disabled) console.warn('[agent] LLM unavailable, using rules:', err instanceof Error ? err.message : err)
    return rulesRespond(user, text, snap)
  }
}

async function llmRespond(user: User, text: string, snap: Snapshot): Promise<AgentReply> {
  const messages: ChatMessage[] = [{ role: 'system', content: systemPrompt(user, snap) }, ...(await history(user.id))]
  if (messages[messages.length - 1]?.content !== text) messages.push({ role: 'user', content: text })
  const out: ToolOut = {}
  const results: string[] = []
  let remainingMs = 25_000
  const engine = serverConfig().llm.baseUrl.includes(':8377') ? 'antseed' : 'llm'
  for (let step = 0; step < 4; step++) {
    const started = Date.now()
    let msg: ChatMessage
    try {
      if (remainingMs <= 0) throw new Error('Chat time budget reached')
      msg = await chat(messages, serverConfig().billsLive ? TOOLS : TOOLS.filter((t) => t.function.name !== 'propose_bill'), 600, { think: false, timeoutMs: Math.min(12_000, remainingMs) })
    } catch (err) {
      // A tool may already have changed a jar or started a paid job. Return its
      // recorded result instead of executing a fallback action a second time.
      if (results.length) return { text: results.join('\n\n'), confirm: out.confirm, extra: out.extra, engine }
      throw err
    } finally { remainingMs -= Date.now() - started }
    if (!msg.tool_calls?.length) {
      return { text: (msg.content ?? '').trim() || results.join('\n\n') || 'Please try asking that again.', confirm: out.confirm, extra: out.extra, engine }
    }
    messages.push({ role: 'assistant', content: msg.content ?? null, tool_calls: msg.tool_calls })
    for (const call of msg.tool_calls) {
      let args: Record<string, unknown> = {}
      try {
        args = JSON.parse(call.function.arguments || '{}')
        if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Invalid tool arguments')
      } catch {
        messages.push({ role: 'tool', tool_call_id: call.id, content: 'error: Invalid arguments. Return valid JSON arguments before running this tool.' })
        continue
      }
      const result = await executeTool(user, call.function.name, args, out)
      results.push(summarizeTool(call.function.name, result))
      messages.push({ role: 'tool', tool_call_id: call.id, content: result })
    }
    // The confirmation text comes from the server's own record of the request, never from the model.
    if (out.confirm) return { text: out.prompt ?? `I'll pay ${out.confirm.summary} with G$ ${out.confirm.gd} from your jar. Confirm?`, confirm: out.confirm, extra: out.extra, engine }
  }
  return { text: results.join('\n\n') || 'Please try asking that again.', confirm: out.confirm, extra: out.extra, engine }
}

function summarizeTool(name: string, result: string): string {
  if (name === 'get_jars') {
    const snap = JSON.parse(result) as Snapshot
    return [...snap.jars.map((j) => `${j.label}: ${formatNgn(j.balanceNgn)}`), `Spare: ${formatNgn(snap.freeNgn)}`].join('\n')
  }
  if (name === 'ai_helpers') return Object.values(AI_TOOLS).map((t) => `${t.name} — G$ ${t.priceGd}`).join('\n')
  if (name === 'my_rewards') {
    const progress = JSON.parse(result) as Awaited<ReturnType<typeof rewardProgress>>
    return `You've earned G$ ${progress.earnedGd.toLocaleString()} in rewards.\n${progress.items.filter((i) => !i.done).map((i) => `${i.title}: ${i.detail}`).join('\n')}`
  }
  if (name === 'recent_activity') return (JSON.parse(result) as { title: string; status: string }[]).map((a) => `${a.title} (${a.status})`).join('\n') || 'No recent activity yet.'
  return result.replace(/^error: /, '')
}

async function rulesRespond(user: User, text: string, snap?: Snapshot, parsed?: Intent): Promise<AgentReply> {
  const intent = parsed ?? fallbackIntent(text)
  const out: ToolOut = {}
  switch (intent.type) {
    case 'bill': {
      const r = await propose(user, { kind: intent.kind, amount_ngn: intent.amountNgn, phone: intent.phone, network: intent.network, plan: intent.plan })
      if (r.confirm) return { text: `I'll pay ${r.confirm.summary} with G$ ${r.confirm.gd} from your jar. Confirm?`, confirm: r.confirm, engine: 'rules' }
      return { text: r.text.replace(/^error: /, ''), engine: 'rules' }
    }
    case 'balance': {
      const current = snap ?? await snapshot(user)
      return {
        text: [...current.jars.map((j) => `${j.emoji} ${j.label}: ${formatNgn(j.balanceNgn)} / ${formatNgn(j.targetNgn)} (${j.pct}%)`), `Spare: ${formatNgn(current.freeNgn)}`].join('\n'),
        engine: 'rules',
      }
    }
    case 'claim': {
      const t = await executeTool(user, 'claim_now', {}, out)
      return { text: t.replace(/^error: /, ''), engine: 'rules' }
    }
    case 'ai': {
      const list = Object.values(AI_TOOLS).map((t) => `• ${t.name} — G$ ${t.priceGd}`).join('\n')
      return { text: `Your G$ can pay for AI help:\n${list}\n\nOpen “AI helpers” in the app, pick one and type your topic. It’s paid from your AI jar.`, engine: 'rules' }
    }
    case 'rewards': {
      const p = await rewardProgress(user)
      return { text: `You've earned G$ ${p.earnedGd.toLocaleString()} in rewards.\n${p.items.filter((i) => !i.done).map((i) => `• ${i.title}: ${i.detail} → G$ ${i.amountGd}`).join('\n')}`, engine: 'rules' }
    }
    case 'run': {
      const t = await executeTool(user, 'run_agent', {}, out)
      return { text: t.replace(/^error: /, ''), engine: 'rules' }
    }
    case 'move': {
      const t = await executeTool(user, 'move_to_jar', { jar: intent.jar, amount_ngn: intent.amountNgn }, out)
      if (out.confirm) return { text: out.prompt ?? t, confirm: out.confirm, engine: 'rules' }
      return { text: t.replace(/^error: /, ''), engine: 'rules' }
    }
    default: {
      const light = snap?.jars.find((j) => j.kind === 'light')
      const disco = light && isDisco(light.details.disco) ? ` (${DISCO_INFO[light.details.disco].short})` : ''
      return {
        text: `I save your G$, pay airtime, data and light${disco}, find rewards, and your G$ pays for AI help (research, assignments, brainstorming). Try:\n• "₦500 airtime to 0803 123 4567"\n• "1GB data for me"\n• "Buy ₦3000 light"\n• "Help me research inflation"\n• "My rewards"`,
        engine: 'rules',
      }
    }
  }
}

export type { JarKind, PendingAction }
