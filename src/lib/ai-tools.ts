import { formatEther, parseEther } from 'viem'
import { chat, llmReachable } from './agent/llm'
import { gdBalance, sendGdFromAgent, treasuryAddress } from './chain'
import { run } from './db'
import { serverConfig } from './env'
import { debitJars, syncJars, withUserLock } from './jars'
import { logActivity, type User } from './users'
import { decryptAgentKey } from './wallets'

// AI helpers people pay for with the G$ they've gathered. Each use moves G$
// from the user's AI jar to the treasury on Celo; the treasury funds the
// AntSeed inference (USDC on Base) that produces the answer.

export const AI_TOOLS = {
  research: {
    name: 'Research brief',
    blurb: 'Any topic, explained simply with key points, examples and what to read next.',
    priceGd: 300,
    placeholder: 'e.g. Causes of inflation in Nigeria since 2016',
    system:
      'You are a research assistant for a Nigerian student. Write a clear research brief on the topic: a 2-sentence summary, 5-7 key points with short explanations, local (Nigerian/African) examples where relevant, common misconceptions, and 3 search terms or kinds of sources to look up next. Do not invent citations, statistics or URLs; say "check a current source" where numbers matter. Under 450 words. Use simple English.',
  },
  assignment: {
    name: 'Assignment helper',
    blurb: 'Understand the question, get an outline and the key ideas — then write it in your own words.',
    priceGd: 250,
    placeholder: 'Paste your assignment question',
    system:
      'You are a study tutor. Help the student understand and plan their assignment, not do it for them. Give: what the question is really asking, key concepts to cover, a suggested outline with headings and what each section should argue, 2-3 guiding questions to think about, and tips for the conclusion. Do not write the full essay. Remind them briefly to write in their own words and cite sources. Under 400 words.',
  },
  brainstorm: {
    name: 'Brainstorm',
    blurb: 'Ideas for a project, topic, event, business or content — fast.',
    priceGd: 150,
    placeholder: 'e.g. Final-year project ideas in computer science about agriculture',
    system:
      'You are a creative brainstorming partner for a young Nigerian. Give 8 varied, concrete ideas as a numbered list, each with one line on why it is good and one first step. Then pick your top 2 and say why. Practical for Nigeria, low budget. Under 400 words.',
  },
  exam: {
    name: 'Exam practice',
    blurb: 'Practice questions with answers for WAEC, JAMB, NECO or your course.',
    priceGd: 200,
    placeholder: 'e.g. JAMB Biology — genetics, 10 questions',
    system:
      'You are an exam coach. Create practice questions on the subject/topic given (WAEC/JAMB/NECO style if mentioned, otherwise university level). Give 8 multiple-choice questions with options A-D, then an answer key with a one-line explanation for each. Accurate and syllabus-appropriate.',
  },
  cv: {
    name: 'CV & cover letter',
    blurb: 'Turn your experience into a strong CV summary and a tailored cover letter.',
    priceGd: 400,
    placeholder: 'Your experience, skills and the job/scholarship you want',
    system:
      'You are a career coach for young Nigerians. From the details given, write: a 3-line professional summary, 5 strong CV bullet points (action verb + result), a skills list, and a short tailored cover letter (under 200 words). Do not invent jobs, degrees or numbers the user did not give; use [brackets] for details they should fill in.',
  },
  opportunities: {
    name: 'Opportunity scout',
    blurb: 'Kinds of scholarships, internships, fellowships and programmes to look for — and how to apply.',
    priceGd: 300,
    placeholder: 'e.g. 300L Economics student in Kaduna, want funded programmes',
    system:
      'You are an opportunities advisor for young Nigerians. Based on the profile, suggest types of opportunities to pursue (scholarships, internships, fellowships, competitions, bootcamps), well-known long-running programmes that commonly fit (name them only if you are confident they exist, and say "check if open this year"), how to find current calls, and an application checklist. Never invent deadlines or links. Under 400 words.',
  },
  hustle: {
    name: 'Side-hustle plan',
    blurb: 'A simple plan to start earning: costs, first customers, pricing.',
    priceGd: 300,
    placeholder: 'e.g. I can bake and I have ₦30,000',
    system:
      'You are a small-business mentor for young Nigerians. Give a 1-page starter plan: the offer, who buys it, startup costs in naira (rough ranges), pricing, how to get the first 10 customers (WhatsApp/Instagram/local), weekly routine, and risks. Realistic and low budget. Under 400 words.',
  },
  content: {
    name: 'Content writer',
    blurb: 'Captions, posts, scripts and bios that sound like you.',
    priceGd: 100,
    placeholder: 'e.g. Instagram caption for my new braids business, fun tone',
    system:
      'You are a social media writer for young Nigerians. Write 3 options in the requested format and tone (Pidgin welcome if asked), with suggested hashtags where relevant. Keep each short and punchy.',
  },
} as const

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
export async function runAiTool(user: User, tool: AiToolId, input: string): Promise<{ ok: boolean; output: string; costGd: number; demo: boolean; message?: string }> {
  const spec = AI_TOOLS[tool]
  const text = input.trim().slice(0, 2000)
  if (text.length < 3) return { ok: false, output: '', costGd: 0, demo: false, message: 'Tell me a bit more first.' }
  const cost = parseEther(String(spec.priceGd))

  return withUserLock(user.id, async () => {
    await syncJars(user)
    if ((await gdBalance(user.agentAddress)) < cost) {
      return { ok: false, output: '', costGd: 0, demo: false, message: `This costs G$ ${spec.priceGd}. Your jars will fill as Jara claims your daily G$.` }
    }

    if (!(await llmReachable())) {
      if (serverConfig().chain.mode !== 'mock') return { ok: false, output: '', costGd: 0, demo: false, message: 'The AI brain is offline right now. You were not charged — try again soon.' }
      const output = demoAnswer(tool, text)
      await run('INSERT INTO ai_runs (user_id, tool, input, output, cost_gd, demo, created_at) VALUES (?, ?, ?, ?, 0, 1, ?)', [user.id, tool, text, output, Date.now()])
      return { ok: true, output, costGd: 0, demo: true }
    }

    let output: string
    try {
      const msg = await chat(
        [
          { role: 'system', content: spec.system },
          { role: 'user', content: text },
        ],
        [],
        1200,
      )
      output = (msg.content ?? '').trim()
      if (!output) throw new Error('empty answer')
    } catch (err) {
      console.error('[ai-tools] LLM failed', err)
      return { ok: false, output: '', costGd: 0, demo: false, message: 'The AI brain didn’t answer. You were not charged.' }
    }

    // Pay: AI jar first, then spare G$, then other jars.
    if (!(await debitJars(user, 'ai', cost))) return { ok: false, output: '', costGd: 0, demo: false, message: 'Not enough G$.' }
    let hash: string | undefined
    try {
      hash = await sendGdFromAgent(decryptAgentKey(user.agentKeyEnc), treasuryAddress(), cost)
    } catch (err) {
      console.error('[ai-tools] G$ payment failed after answer', user.id, err)
    }
    await run('INSERT INTO ai_runs (user_id, tool, input, output, cost_gd, demo, created_at) VALUES (?, ?, ?, ?, ?, 0, ?)', [user.id, tool, text, output, spec.priceGd, Date.now()])
    await logActivity(user.id, {
      type: 'ai',
      jar: 'ai',
      amountWei: cost.toString(),
      txHash: hash,
      title: `${spec.name}: ${text.slice(0, 60)}${text.length > 60 ? '…' : ''}`,
      detail: `Paid G$ ${Number(formatEther(cost)).toLocaleString()} from your AI jar`,
    })
    return { ok: true, output, costGd: spec.priceGd, demo: false }
  })
}
