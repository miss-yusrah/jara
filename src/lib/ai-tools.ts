import { formatEther, parseEther } from 'viem'
import { chat, llmReachable } from './agent/llm'
import { PaymentFailedError, spendGd } from './spend'
import { moneyRequest } from './money-request'
import { atomic, run } from './db'
import { serverConfig } from './env'
import { getJars, syncJars, withUserLock } from './jars'
import { type User } from './users'

// AI helpers people pay for with the G$ they've gathered. Each use moves G$
// from the user's AI jar to the treasury on Celo; the treasury funds the
// AntSeed inference (USDC on Base) that produces the answer.

/** Shared rules for every helper. */
export const AI_BASE_PROMPT = [
  'You are Jara AI, a study and work assistant for young Nigerians, paid for with GoodDollar (G$).',
  'Write in clear, simple English (Pidgin only if the user writes in Pidgin). Be warm but get to the point.',
  'Format every answer in Markdown: a short title as "# Title", "## " section headings, bullet or numbered lists, **bold** for key terms, and tables when comparing things.',
  'Use Nigerian and African examples where they fit (naira, WAEC/JAMB/NECO, Nigerian universities, local businesses).',
  'Never invent statistics, quotes, citations, URLs, deadlines or people. If a number matters, say "check a current source". Only name books, reports or organisations you are confident exist.',
  'For follow-up questions, build on the earlier conversation instead of repeating it.',
].join(' ')

export const AI_TOOLS = {
  research: {
    name: 'Research',
    blurb: 'A full research brief on any topic, structured like a short paper you can download.',
    priceGd: 300,
    maxTokens: 2400,
    placeholder: 'e.g. Causes and effects of inflation in Nigeria since 2016',
    system:
      'Task: write a research brief like a short academic paper (700-1000 words) with these sections: # Title; ## Summary (3-4 sentences); ## Background; ## Key findings (5-7 points, each explained in 2-3 sentences); ## Nigerian / African context; ## Different views and debates; ## Conclusion; ## Further reading (5 precise search terms, the kinds of sources to check such as CBN or NBS reports, journals, textbooks, and only well-known real works you are sure of). Be balanced and accurate.',
  },
  assignment: {
    name: 'Assignment',
    blurb: 'Breaks down your assignment, gives a full outline, key arguments and a model introduction.',
    priceGd: 250,
    maxTokens: 2400,
    placeholder: 'Paste your assignment question and your course/level',
    system:
      'Task: help the student produce an excellent assignment in their own words. Give: # a working title; ## What the question is really asking (key instruction words explained); ## Key concepts to define; ## Full outline (Introduction, 3-5 body sections, Conclusion), and under each section the main argument, 2-3 supporting points and the kind of evidence or example to use; ## Model introduction (one well-written paragraph they can learn from and adapt); ## How to write the conclusion; ## References to look for (types of sources and search terms; real well-known texts only); ## Checklist before submitting (referencing style, word count, proofreading). Do not write the whole body of the essay. End with one line reminding them to write it in their own words and cite their sources.',
  },
  brainstorm: {
    name: 'Brainstorm',
    blurb: 'Ideas for a project, topic, event, business or content, fast.',
    priceGd: 150,
    maxTokens: 1400,
    placeholder: 'e.g. Final-year project ideas in computer science about agriculture',
    system:
      'Task: give 8 varied, concrete ideas as a numbered list. For each: a bold name, one line on why it is good, one first step. Then ## Top 2 picks with reasons. Practical for Nigeria and low budget.',
  },
  exam: {
    name: 'Exam practice',
    blurb: 'A full-screen, 20-question practice session with selectable answers and a results review.',
    priceGd: 200,
    maxTokens: 2000,
    placeholder: 'e.g. JAMB Biology: genetics, ecology and cell biology',
    system:
      'Task: create practice questions on the subject/topic given (WAEC/JAMB/NECO style if mentioned, otherwise university level). Give 20 multiple-choice questions with options A-D, then ## Answers with a one-line explanation each, then ## Topics to revise. Accurate and syllabus-appropriate.',
  },
  cv: {
    name: 'CV & cover letter',
    blurb: 'Turn your experience into a strong CV and a tailored cover letter.',
    priceGd: 400,
    maxTokens: 1800,
    placeholder: 'Your experience, skills and the job or scholarship you want',
    system:
      'Task: from the details given, write: ## Professional summary (3 lines); ## Experience bullet points (5, action verb + result); ## Skills; ## Cover letter (under 250 words, tailored). Do not invent jobs, degrees or numbers the user did not give; use [brackets] for details they should fill in.',
  },
  opportunities: {
    name: 'Opportunities',
    blurb: 'Scholarships, internships, fellowships and programmes to look for, and how to apply.',
    priceGd: 300,
    maxTokens: 1800,
    placeholder: 'e.g. 300L Economics student in Kaduna, want funded programmes',
    system:
      'Task: suggest types of opportunities to pursue (scholarships, internships, fellowships, competitions, bootcamps), well-known long-running programmes that commonly fit (only ones you are confident exist, each marked "check if open this year"), how to find current calls, and an application checklist. Never invent deadlines or links.',
  },
  hustle: {
    name: 'Side hustle',
    blurb: 'A simple plan to start earning: costs, first customers, pricing.',
    priceGd: 300,
    maxTokens: 1800,
    placeholder: 'e.g. I can bake and I have ₦30,000',
    system:
      'Task: a one-page starter plan: the offer, who buys it, startup costs in naira (rough ranges, as a table), pricing, how to get the first 10 customers (WhatsApp, Instagram, local), weekly routine, and risks. Realistic and low budget.',
  },
  content: {
    name: 'Content writer',
    blurb: 'Captions, posts, scripts and bios that sound like you.',
    priceGd: 100,
    maxTokens: 1000,
    placeholder: 'e.g. Instagram caption for my new braids business, fun tone',
    system:
      'Task: write 3 options in the requested format and tone, with suggested hashtags where relevant. Short and punchy.',
  },
} as const

/** Follow-up questions in the same chat cost less than the first answer. */
export const followUpPrice = (tool: keyof typeof AI_TOOLS) => Math.max(50, Math.round(AI_TOOLS[tool].priceGd / 3 / 10) * 10)

export type AiToolId = keyof typeof AI_TOOLS
export const isAiTool = (t: unknown): t is AiToolId => typeof t === 'string' && t in AI_TOOLS

export interface AiRun {
  id: number
  tool: AiToolId
  input: string
  output: string
  costGd: number
  demo: boolean
  createdAt: number
}

export async function listAiRuns(userId: string, limit = 10): Promise<AiRun[]> {
  const r = await run('SELECT * FROM ai_runs WHERE user_id = ? ORDER BY id DESC LIMIT ?', [userId, limit])
  return r.rows.map((x) => ({
    id: Number(x.id),
    tool: x.tool as AiToolId,
    input: x.input as string,
    output: x.output as string,
    costGd: Number(x.cost_gd),
    demo: Number(x.demo) === 1,
    createdAt: Number(x.created_at),
  }))
}

function demoAnswer(tool: AiToolId, input: string): string {
  return `⚠️ Demo preview — Jara's AI brain (AntSeed) isn't connected, so this is a sample layout, not a real answer.\n\n${AI_TOOLS[tool].name} for: “${input.slice(0, 120)}”\n\n1. Summary of what you asked\n2. Key points, explained simply\n3. Examples that fit Nigeria\n4. What to do next\n\nConnect AntSeed (LLM_BASE_URL) for real answers. You were not charged.`
}

/**
 * Run an AI helper and pay for it in G$ from the user's jars (AI jar first).
 * Charges only after a real answer comes back.
 */
export async function runAiTool(user: User, tool: AiToolId, input: string, requestId: string): Promise<{ ok: boolean; output: string; costGd: number; demo: boolean; message?: string; /** The charge is not confirmed yet: retry the same request ID. */ pending?: boolean }> {
  if (tool === 'exam') {
    try {
      const { createExam } = await import('./exams')
      const result = await createExam(user, input, requestId)
      return { ok: true, output: `Your 20-question practice session is ready. Choose your answers one at a time, then see your score and explanations.\n\nOpen exam prep: ${serverConfig().appUrl}/app/exam?run=${result.id}`, costGd: result.costGd, demo: false }
    } catch (err) {
      return { ok: false, output: '', costGd: 0, demo: false, message: err instanceof Error ? err.message : 'Could not prepare your practice.', pending: err instanceof Error && 'status' in err && err.status === 409 }
    }
  }
  const spec = AI_TOOLS[tool]
  const text = input.trim().slice(0, 2000)
  if (text.length < 3) return { ok: false, output: '', costGd: 0, demo: false, message: 'Tell me a bit more first.' }
  const result = await runPaidJob(user, {
    requestId,
    tool,
    title: `${spec.name}: ${text.slice(0, 60)}`,
    input: text,
    priceGd: spec.priceGd,
    produce: async () => {
      const msg = await chat([{ role: 'system', content: `${AI_BASE_PROMPT}\n\n${spec.system}` }, { role: 'user', content: text }], [], spec.maxTokens)
      return msg.content
    },
  })
  if (result.ok) return { ...result, demo: false }
  if (result.reason === 'offline' && serverConfig().chain.mode === 'mock') return { ok: true, output: demoAnswer(tool, text), costGd: 0, demo: true }
  return { ok: false, output: '', costGd: 0, demo: false, pending: result.reason === 'payment', message: result.reason === 'failed' ? 'The payment failed without transferring G$. Start a new request to try again.' : result.reason === 'funds' ? 'Not enough G$ in your AI jar. Move money into it first.' : result.reason === 'payment' ? 'Payment is not confirmed. Retry this same request to check it.' : 'The AI helper is unavailable. No payment was started.' }
}

interface PaidJobData {
  type: 'ai-job'
  tool: AiToolId
  title: string
  input: string
  priceGd: number
  output: string
}

/** Save the answer before charging; never regenerate or charge again on a retry. */
export async function runPaidJob(
  user: User,
  job: { requestId: string; tool: AiToolId; title: string; input: string; priceGd: number; produce: () => Promise<string | null> },
): Promise<{ ok: true; output: string; costGd: number } | { ok: false; reason: 'funds' | 'offline' | 'empty' | 'payment' | 'failed' }> {
  return withUserLock(user.id, async () => {
    const request = await moneyRequest<PaidJobData>(user.id, `ai-job:${job.requestId}`, { tool: job.tool, input: job.input, priceGd: job.priceGd })
    if (request.result) return request.result
    if (!request.data) {
      await syncJars(user)
      const jar = (await getJars(user.id)).find((j) => j.kind === 'ai')!
      if (jar.balanceWei < parseEther(String(job.priceGd))) return { ok: false, reason: 'funds' }
      if (!(await llmReachable())) return { ok: false, reason: 'offline' }
      let output: string | null
      try { output = (await job.produce())?.trim() || null } catch { return { ok: false, reason: 'offline' } }
      if (!output) return { ok: false, reason: 'empty' }
      request.data = { type: 'ai-job', tool: job.tool, title: job.title, input: job.input, priceGd: job.priceGd, output }
      await request.save(request.data)
    }
    return finishPaidJob(user, request.id, request.data)
  })
}

async function finishPaidJob(user: User, id: string, data: PaidJobData): Promise<{ ok: true; output: string; costGd: number } | { ok: false; reason: 'payment' | 'failed' }> {
  const cost = parseEther(String(data.priceGd))
  let hash: string
  try { hash = (await spendGd(user, cost, { id, jar: 'ai' })).hash } catch (err) {
    if (err instanceof PaymentFailedError) {
      const result = { ok: false as const, reason: 'failed' as const }
      await run('UPDATE money_requests SET result = ? WHERE id = ?', [JSON.stringify(result), id])
      return result
    }
    console.warn('[ai] payment not confirmed', id, err instanceof Error ? err.message : err)
    return { ok: false, reason: 'payment' }
  }
  const result = { ok: true as const, output: data.output, costGd: data.priceGd }
  await atomic(async (tx) => {
    const saved = (await tx.execute({ sql: 'SELECT result FROM money_requests WHERE id = ?', args: [id] })).rows[0]
    if (saved.result) return
    await tx.execute({ sql: 'INSERT INTO ai_runs(user_id, tool, input, output, cost_gd, demo, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)', args: [user.id, data.tool, data.input, data.output, data.priceGd, Date.now()] })
    await tx.execute({ sql: `INSERT INTO activity(user_id, type, jar, amount_wei, tx_hash, title, detail, operation_id, created_at) VALUES (?, 'ai', 'ai', ?, ?, ?, ?, ?, ?)`, args: [user.id, String(cost), hash, data.title, `Paid G$ ${formatEther(cost)} from your AI jar`, id, Date.now()] })
    await tx.execute({ sql: 'UPDATE money_requests SET result = ? WHERE id = ?', args: [JSON.stringify(result), id] })
  })
  return result
}

export async function recoverPaidJobs(user: User) {
  const rows = (await run("SELECT * FROM money_requests WHERE user_id = ? AND result IS NULL AND data IS NOT NULL AND id LIKE ?", [user.id, `${user.id}:ai-job:%`])).rows
  for (const row of rows) {
    const data = JSON.parse(String(row.data)) as PaidJobData
    if (data.type === 'ai-job') await withUserLock(user.id, () => finishPaidJob(user, String(row.id), data))
  }
}
