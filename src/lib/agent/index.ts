import { AsyncLocalStorage } from 'node:async_hooks'
import { moneyRequest } from '../money-request'
import { formatEther } from 'viem'
import { describeAction, payBill, prepareBill } from '../bills'
import { DISCO_INFO, formatNgn, isDisco, isNetwork, normalizePhone, detectNetwork } from '../catalog'
import { run } from '../db'
import { serverConfig } from '../env'
import { moveToJar, snapshot, updateJar, withUserLock, type Snapshot } from '../jars'
import { runDaily } from '../daily'
import { getUserById, isBillKind, isJarKind, listActivity, updateUser, type JarKind, type PendingAction, type User } from '../users'
import { chat, llmReachable, type ChatMessage, type ToolDef } from './llm'
import { directIntent, fallbackIntent, type Intent } from './fallback'
import { runAgent } from './routine'
import { AI_TOOLS, isAiTool, runAiTool } from '../ai-tools'
import { rewardProgress } from '../rewards'
import { DRILL_PRICE_GD, EXAMS, SCOUT_PRICE_GD, daysUntil, examDrill, getJobs, isExam, opportunityScout, parseSubjects, saveJobs, saveToChat } from './jobs'

export interface AgentReply {
  text: string
  /** Set when a bill is waiting for the user to tap Confirm. */
  confirm?: { id: string; summary: string; gd: number }
  explorerUrl?: string
  /** Extra messages to deliver after the reply (e.g. the first exam drill). */
  extra?: string[]
  engine: 'antseed' | 'llm' | 'rules'
}

const YES = /^(y|yes|yeah|yep|ok|okay|confirm|go|oya|do it|sure|pay|send)\b/i
const NO = /^(n|no|nope|cancel|stop|abeg no|leave it)\b/i
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
      description: 'Move naira-worth of G$ into a jar from the spare balance or other jars.',
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
      description: 'Change a jar: savings target in naira, auto-pay on/off, or the phone number/network it pays.',
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
        'Run an AI helper and pay its G$ price from the AI jar. Only call when the user clearly asked for it AND knows the price (tell them the price first if they have not agreed). Returns the answer to show the user in full.',
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
      description: `Switch daily exam prep on or off. Each morning until the exam, Jara prepares a full-screen 20-question practice session, rotating through the subjects, for G$ ${DRILL_PRICE_GD} from the AI jar. Users select answers one at a time and review their score at the end. Tell the user the price before switching it on. The first session link is sent right away.`,
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
      description: `Switch the opportunity scout on or off. Every 3 days Jara checks real scholarship, internship and fellowship listings and sends up to 3 that match the user's interests, for G$ ${SCOUT_PRICE_GD} (only charged when something matches). Tell the user the price first.`,
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
  await updateUser(user.id, { pending: prepared.action })
  const gd = Number(formatEther(BigInt(prepared.action.quoteWei!)))
  const summary = describeAction(prepared.action)
  return { text: `ready to confirm: ${summary} costing G$ ${gd.toFixed(0)}`, confirm: { id: prepared.action.id!, summary, gd: Math.ceil(gd) } }
}

async function setJar(user: User, args: Record<string, unknown>): Promise<string> {
  if (!isJarKind(args.jar)) return 'error: unknown jar'
  const details: Record<string, string> = {}
  if (typeof args.phone === 'string') {
    const phone = normalizePhone(args.phone, true)
    if (!phone) return 'error: invalid phone'
    details.phone = phone
    details.network = (isNetwork(args.network) ? args.network : detectNetwork(phone)) ?? ''
  }
  await updateJar(user.id, args.jar, {
    targetNgn: typeof args.target_ngn === 'number' ? args.target_ngn : undefined,
    autoPay: typeof args.auto_pay === 'boolean' ? args.auto_pay : undefined,
    details,
  })
  return `updated ${args.jar} jar`
}

type ToolOut = { confirm?: AgentReply['confirm']; extra?: string[] }

async function executeTool(user: User, name: string, args: Record<string, unknown>, out: ToolOut) {
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
      const messageId = agentRequestContext.getStore()
      if (!messageId) throw new Error('A saved message is required before changing budgets.')
      const r = await moveToJar(user, args.jar, Number(args.amount_ngn), `message:${messageId}`)
      return r.movedGd > 0 ? `moved G$ ${r.movedGd.toFixed(0)}` : 'error: no G$ available to move'
    }
    case 'set_jar':
      return setJar(user, args)
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
      const fresh = (await getUserById(user.id))!
      const messageId = agentRequestContext.getStore()
      if (!messageId) throw new Error('A saved message is required before starting paid AI.')
      const r = await runAiTool(fresh, args.tool, String(args.input ?? ''), `message:${messageId}:ai`)
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
      return r.sent ? `${r.text}. The first drill is being sent as a separate message right after your reply; don't repeat it.` : r.text
    }
    case 'set_opportunity_scout': {
      if (args.on === false) {
        await saveJobs(user.id, { scoutOn: false })
        return 'opportunity scout switched off'
      }
      const r = await setScout(user, args.interests)
      if ('error' in r) return `error: ${r.error}`
      if (r.sent) (out.extra ??= []).push(r.sent)
      return r.sent ? `${r.text}. The matches are being sent as a separate message right after your reply; don't repeat them.` : r.text
    }
    case 'recent_activity':
      return JSON.stringify((await listActivity(user.id, 6)).map((a) => ({ title: a.title, status: a.status, when: new Date(a.createdAt).toISOString() })))
    default:
      return `error: unknown tool ${name}`
  }
}

// ---------- proactive jobs (shared by chat tools and the web API) ----------

export async function setExamPrep(
  user: User,
  input: { exam?: unknown; subjects?: unknown; examDate?: unknown },
): Promise<{ error: string } | { text: string; sent?: string }> {
  const current = await getJobs(user.id)
  const exam = input.exam === undefined ? current.exam : input.exam
  if (!isExam(exam)) return { error: `exam must be one of ${EXAMS.join(', ')}` }
  const subjects = input.subjects === undefined ? current.examSubjects : parseSubjects(input.subjects)
  if (!subjects.length) return { error: 'which subjects? (e.g. Biology, Chemistry)' }
  const date = input.examDate === undefined ? current.examDate : typeof input.examDate === 'string' ? input.examDate : null
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || Number.isNaN(Date.parse(date))) return { error: 'what date is the exam? (YYYY-MM-DD)' }
  const left = daysUntil(date)
  if (left < 1 || left > 400) return { error: 'the exam date should be in the future, within about a year' }
  const restart = !current.examOn || current.exam !== exam
  await saveJobs(user.id, { examOn: true, exam, examSubjects: subjects, examDate: date, ...(restart ? { examCount: 0, examLastDay: null } : {}) })
  // Send the first drill right away so they see what they signed up for.
  const first = await examDrill((await getUserById(user.id))!, await getJobs(user.id)).catch(() => null)
  const base = `daily ${exam} drills on: ${subjects.join(', ')}, until ${date} (${left} days), G$ ${DRILL_PRICE_GD} each`
  return { text: first ? `${base}. ${first.text}` : base, sent: first?.message }
}

export async function setScout(user: User, interests: unknown): Promise<{ error: string } | { text: string; sent?: string }> {
  const current = await getJobs(user.id)
  const text = typeof interests === 'string' ? interests.trim().replace(/\s+/g, ' ').slice(0, 200) : current.scoutInterests
  if (!text || text.length < 3) return { error: 'what kind of opportunities? (e.g. engineering scholarships, tech internships)' }
  await saveJobs(user.id, { scoutOn: true, scoutInterests: text, scoutLastAt: null })
  const first = await opportunityScout((await getUserById(user.id))!, await getJobs(user.id)).catch(() => null)
  const base = `opportunity scout on for "${text}": checks every 3 days, G$ ${SCOUT_PRICE_GD} only when something matches`
  return { text: first ? `${base}. ${first.text}` : `${base}. Nothing new matched today; I'll keep looking.`, sent: first?.message }
}

// ---------- main entry ----------

const agentRequestContext = new AsyncLocalStorage<string>()

export async function handleMessage(userId: string, text: string, requestId: string): Promise<AgentReply> {
  return withUserLock(userId, async () => {
    const request = await moneyRequest(userId, `message:${requestId}`, { text: text.trim() })
    if (request.result) return request.result as AgentReply
    return agentRequestContext.run(requestId, async () => {
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

async function respond(user: User, text: string): Promise<AgentReply> {
  if (user.pending && YES.test(text)) return resolvePending(user.id, true)
  if (user.pending && NO.test(text)) return resolvePending(user.id, false)

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
    if (out.confirm) return { text: `I'll pay ${out.confirm.summary} with G$ ${out.confirm.gd} from your jar. Confirm?`, confirm: out.confirm, extra: out.extra, engine }
    // Paid helper output is already the answer, not input for another AI rewrite.
    if (msg.tool_calls.some((call) => call.function.name === 'use_ai_helper')) return { text: results.join('\n\n'), extra: out.extra, engine }
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
  const out: { confirm?: AgentReply['confirm'] } = {}
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
      return { text: t.startsWith('error') ? "There's no spare G$ to move right now." : `Done — ${t.replace('moved', 'moved')} into ${intent.jar}.`, engine: 'rules' }
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
