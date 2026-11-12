import { runPaidJob } from '../ai-tools'
import { generateExamPaper } from '../exam-generator'
import { EXAM_OPTIONS, EXAM_QUESTION_COUNT } from '../exam-paper'
import { examRunId } from '../exams'
import { verificationExpiresAt } from '../chain'
import { run } from '../db'
import { serverConfig } from '../env'
import type { User } from '../users'
import { chat } from './llm'

// Proactive jobs the agent does on its own schedule, once the user switches them on:
//   EXAM PREP   a short daily drill for their exam (WAEC, JAMB…) until exam day, paid from the AI jar
//   SCOUT       real opportunities (scholarships, internships, fellowships) from public feeds, matched
//               to their interests every few days; paid only when something matches
//   VERIFY      a free warning before their GoodDollar face check expires and daily claims stop

export const EXAMS = EXAM_OPTIONS
export type Exam = (typeof EXAMS)[number]
export const isExam = (v: unknown): v is Exam => typeof v === 'string' && (EXAMS as readonly string[]).includes(v)

export const DRILL_PRICE_GD = 50
export const SCOUT_PRICE_GD = 50
const DAY = 86_400_000
const SCOUT_EVERY = 3 * DAY
const VERIFY_WARN_BEFORE = 7 * DAY
const VERIFY_REPEAT = 3 * DAY

export interface AgentJobs {
  examOn: boolean
  exam: Exam | null
  examSubjects: string[]
  examDate: string | null
  examLastDay: string | null
  examCount: number
  scoutOn: boolean
  scoutInterests: string | null
  scoutLastAt: number | null
  verifyWarnedAt: number | null
}

export interface JobNotice {
  lane: 'save' | 'ai'
  /** One line for the agent summary and log. */
  text: string
  /** A separate message to deliver (Telegram), if any. */
  message?: string
}

// ---------- settings ----------

export async function getJobs(userId: string): Promise<AgentJobs> {
  const r = (await run('SELECT * FROM agent_jobs WHERE user_id = ?', [userId])).rows[0]
  return {
    examOn: Number(r?.exam_on ?? 0) === 1,
    exam: isExam(r?.exam) ? r.exam : null,
    examSubjects: r?.exam_subjects ? (JSON.parse(r.exam_subjects as string) as string[]) : [],
    examDate: (r?.exam_date as string | null) ?? null,
    examLastDay: (r?.exam_last_day as string | null) ?? null,
    examCount: Number(r?.exam_count ?? 0),
    scoutOn: Number(r?.scout_on ?? 0) === 1,
    scoutInterests: (r?.scout_interests as string | null) ?? null,
    scoutLastAt: r?.scout_last_at == null ? null : Number(r.scout_last_at),
    verifyWarnedAt: r?.verify_warned_at == null ? null : Number(r.verify_warned_at),
  }
}

export async function saveJobs(userId: string, patch: Partial<AgentJobs>) {
  const cols: Record<string, string | number | null> = {}
  if ('examOn' in patch) cols.exam_on = patch.examOn ? 1 : 0
  if ('exam' in patch) cols.exam = patch.exam ?? null
  if ('examSubjects' in patch) cols.exam_subjects = JSON.stringify(patch.examSubjects ?? [])
  if ('examDate' in patch) cols.exam_date = patch.examDate ?? null
  if ('examLastDay' in patch) cols.exam_last_day = patch.examLastDay ?? null
  if ('examCount' in patch) cols.exam_count = patch.examCount ?? 0
  if ('scoutOn' in patch) cols.scout_on = patch.scoutOn ? 1 : 0
  if ('scoutInterests' in patch) cols.scout_interests = patch.scoutInterests ?? null
  if ('scoutLastAt' in patch) cols.scout_last_at = patch.scoutLastAt ?? null
  if ('verifyWarnedAt' in patch) cols.verify_warned_at = patch.verifyWarnedAt ?? null
  const keys = Object.keys(cols)
  if (!keys.length) return
  await run('INSERT OR IGNORE INTO agent_jobs (user_id) VALUES (?)', [userId])
  await run(`UPDATE agent_jobs SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE user_id = ?`, [...Object.values(cols), userId])
}

/** Clean, validated subjects list from free text ("Biology, Chemistry and Physics"). */
export function parseSubjects(input: unknown): string[] {
  const raw = Array.isArray(input) ? input.join(',') : typeof input === 'string' ? input : ''
  return [
    ...new Set(
      raw
        .split(/,|\band\b|\n|;/i)
        .map((s) => s.trim().replace(/\s+/g, ' ').slice(0, 40))
        .filter((s) => s.length >= 2),
    ),
  ].slice(0, 9)
}

// ---------- time helpers (Lagos) ----------

export function lagosDay(offsetDays = 0): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Africa/Lagos' }).format(new Date(Date.now() + offsetDays * DAY))
}

export function lagosHour(): number {
  return Number(new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Lagos', hour: '2-digit', hourCycle: 'h23' }).format(new Date()))
}

export function daysUntil(date: string, today = lagosDay()): number {
  return Math.round((Date.parse(`${date}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / DAY)
}

// ---------- EXAM PREP ----------

export async function examDrill(user: User, jobs: AgentJobs): Promise<JobNotice | null> {
  if (!jobs.examOn || !jobs.exam || !jobs.examDate || !jobs.examSubjects.length) return null
  const today = lagosDay()
  if (jobs.examLastDay === today) return null
  const left = daysUntil(jobs.examDate, today)

  if (left < 0) {
    await saveJobs(user.id, { examOn: false })
    return { lane: 'ai', text: `Your ${jobs.exam} date has passed, so I stopped the daily drills` }
  }
  if (left === 0) {
    await saveJobs(user.id, { examLastDay: today, examOn: false })
    return {
      lane: 'ai',
      text: `It’s ${jobs.exam} day — no drill today`,
      message: `📚 Today na your ${jobs.exam}! You’ve done ${jobs.examCount} drill${jobs.examCount === 1 ? '' : 's'} with me. Read the questions slowly, answer the easy ones first, and go well. You’ve got this. 💪`,
    }
  }

  const subject = jobs.examSubjects[jobs.examCount % jobs.examSubjects.length]
  const dayN = jobs.examCount + 1
  const res = await runPaidJob(user, {
    requestId: `exam:${today}`,
    tool: 'exam',
    title: `Daily ${jobs.exam} drill: ${subject}`,
    input: `[agent] Daily ${jobs.exam} drill · ${subject} · ${left} days to go`,
    priceGd: DRILL_PRICE_GD,
    produce: () => generateExamPaper(`${jobs.exam} ${subject} — Day ${dayN}. Mixed syllabus practice, ${left} days until the exam.`),
  })

  if (res.ok) {
    const runId = await examRunId(user.id, res.output)
    await saveJobs(user.id, { examLastDay: today, examCount: dayN })
    return {
      lane: 'ai',
      text: `Sent today’s ${jobs.exam} ${subject} drill (G$ ${res.costGd}) · ${left} day${left === 1 ? '' : 's'} to go`,
      message: `📚 ${left} day${left === 1 ? '' : 's'} to your ${jobs.exam}. Your ${EXAM_QUESTION_COUNT}-question ${subject} practice is ready.\n\nSelect your answers one at a time, then review your score and explanations:\n${serverConfig().appUrl}/app/exam?run=${runId}\n\n(G$ ${res.costGd} from your AI jar. Opening or resuming this practice is free.)`,
    }
  }
  if (res.reason === 'funds') {
    await saveJobs(user.id, { examLastDay: today })
    return { lane: 'ai', text: `Skipped today’s ${jobs.exam} drill: your AI jar is short of G$ ${DRILL_PRICE_GD}. I’ll try again tomorrow` }
  }
  return null // AI offline: try again on the next run, nothing charged
}

// ---------- OPPORTUNITY SCOUT ----------

// Public RSS feeds of opportunities open to Africans. The AI only chooses from
// these real listings; titles, deadlines and links come straight from the feed.
const FEEDS = ['https://www.opportunitiesforafricans.com/feed/', 'https://opportunitydesk.org/feed/', 'https://www.scholarshipregion.com/feed/']

export interface Opportunity {
  title: string
  link: string
  publishedAt: number
  deadline: string | null
  deadlineAt: number | null
  summary: string
  source: string
}

const decode = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&#0*38;|&amp;/g, '&')
    .replace(/&#0*124;/g, '|')
    .replace(/&#8217;|&#8216;/g, '’')
    .replace(/&#8220;|&#8221;|&quot;/g, '"')
    .replace(/&#8211;|&#8212;/g, '–')
    .replace(/&#8230;/g, '…')
    .replace(/&#\d+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()

function parseFeed(xml: string, source: string): Opportunity[] {
  const out: Opportunity[] = []
  for (const [, item] of xml.matchAll(/<item>([\s\S]*?)<\/item>/g)) {
    const tag = (name: string) => item.match(new RegExp(`<${name}>([\\s\\S]*?)</${name}>`))?.[1] ?? ''
    const title = decode(tag('title'))
    const link = decode(tag('link'))
    if (!title || !/^https:\/\//.test(link)) continue
    const summary = decode(tag('description')).replace(/The post .*$/, '').slice(0, 280)
    const deadline = summary.match(/Deadline:?\s*([A-Z][a-z]+\.? \d{1,2},? \d{4})/)?.[1] ?? null
    const deadlineAt = deadline ? Date.parse(deadline.replace('.', '')) : NaN
    out.push({
      title,
      link,
      publishedAt: Date.parse(tag('pubDate')) || Date.now(),
      deadline,
      deadlineAt: Number.isFinite(deadlineAt) ? deadlineAt : null,
      summary,
      source,
    })
  }
  return out
}

let feedCache: { at: number; items: Opportunity[] } | null = null

export async function fetchOpportunities(): Promise<Opportunity[]> {
  if (feedCache && Date.now() - feedCache.at < 2 * 60 * 60_000) return feedCache.items
  const lists = await Promise.all(
    FEEDS.map(async (url) => {
      try {
        const res = await fetch(url, { headers: { 'user-agent': 'JaraBot/1.0 (+https://usejara.xyz)' }, signal: AbortSignal.timeout(20_000) })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return parseFeed(await res.text(), new URL(url).hostname.replace(/^www\./, ''))
      } catch (err) {
        console.warn('[scout] feed failed', url, err instanceof Error ? err.message : err)
        return []
      }
    }),
  )
  const seen = new Set<string>()
  const items = lists.flat().filter((o) => (seen.has(o.link) ? false : (seen.add(o.link), true)))
  if (items.length) feedCache = { at: Date.now(), items }
  return items
}

export async function opportunityScout(user: User, jobs: AgentJobs): Promise<JobNotice | null> {
  if (!jobs.scoutOn || !jobs.scoutInterests) return null
  if (jobs.scoutLastAt && Date.now() - jobs.scoutLastAt < SCOUT_EVERY) return null

  const seen = new Set((await run('SELECT link FROM scout_seen WHERE user_id = ?', [user.id])).rows.map((r) => r.link as string))
  const now = Date.now()
  const candidates = (await fetchOpportunities())
    .filter((o) => !seen.has(o.link) && (o.deadlineAt === null || o.deadlineAt > now + DAY) && now - o.publishedAt < 30 * DAY)
    .slice(0, 40)
  if (!candidates.length) {
    await saveJobs(user.id, { scoutLastAt: now })
    return null
  }

  let picks: { o: Opportunity; why: string }[] = []
  const res = await runPaidJob(user, {
    requestId: `scout:${Math.floor(now / SCOUT_EVERY)}`,
    tool: 'opportunities',
    title: 'Opportunity scout: new matches for you',
    input: `[agent] Opportunity scout · ${jobs.scoutInterests}`,
    priceGd: SCOUT_PRICE_GD,
    produce: async () => {
      const list = candidates.map((o, i) => `${i}. ${o.title}${o.deadline ? ` (deadline ${o.deadline})` : ''} — ${o.summary.slice(0, 160)}`).join('\n')
      const msg = await chat(
        [
          {
            role: 'system',
            content:
              'You match real opportunities to a young person in Nigeria. From the numbered list, choose at most 3 that clearly fit their interests AND that someone living in Nigeria could apply for (skip ones limited to other countries, e.g. "for South Africans" or "US citizens only"). Reply with one line per pick, best first, exactly in this form:\n<number> | <why it suits them, max 15 words>\nNo other text. If nothing fits, reply NONE.',
          },
          {
            role: 'user',
            content: `Their interests: ${jobs.scoutInterests}${user.city ? `. City: ${user.city}` : ''}.\n\nOpportunities:\n${list}\n\nPick at most 3 that fit their interests and are open to someone in Nigeria. Answer ONLY with lines like:\n13 | short reason\n4 | short reason\nor the single word NONE. No headings, no other text.`,
          },
        ],
        [],
        400,
        { think: false },
      )
      // "13 | why…" lines. Tolerant of bullets, bold and a cut-off last line.
      const used = new Set<number>()
      picks = (msg.content ?? '')
        .split('\n')
        .map((line) => line.replace(/[*`#]/g, '').match(/^\s*[-•]?\s*(\d+)[.)]?\s*[|:–-]\s*(.+)$/))
        .filter((m): m is RegExpMatchArray => Boolean(m))
        .map((m) => ({ i: Number(m[1]), why: m[2].trim().slice(0, 140) }))
        .filter((p) => p.i < candidates.length && !used.has(p.i) && (used.add(p.i), true))
        .slice(0, 3)
        .map((p) => ({ o: candidates[p.i], why: p.why }))
      if (!picks.length) return null
      // Everything below comes from the feed itself, not the model.
      return picks
        .map(({ o, why }, n) => `${n + 1}. ${o.title}${o.deadline ? `\n   Deadline: ${o.deadline}` : ''}${why ? `\n   Why: ${why}` : ''}\n   ${o.link}`)
        .join('\n\n')
    },
  })

  if (!res.ok && res.reason === 'offline') return null
  await saveJobs(user.id, { scoutLastAt: now })
  if (!res.ok) {
    if (res.reason === 'funds') return { lane: 'ai', text: `Opportunity scout skipped: your AI jar is short of G$ ${SCOUT_PRICE_GD}` }
    return null // nothing matched: nothing charged, nothing sent
  }
  for (const { o } of picks) await run('INSERT OR IGNORE INTO scout_seen (user_id, link, created_at) VALUES (?, ?, ?)', [user.id, o.link, now])
  return {
    lane: 'ai',
    text: `Found ${picks.length} new opportunit${picks.length === 1 ? 'y' : 'ies'} for you (G$ ${res.costGd})`,
    message: `🔎 New opportunities that match you:\n\n${res.output}\n\nAlways apply on the official site, and never pay anyone to apply. (G$ ${res.costGd} from your AI jar)`,
  }
}

// ---------- VERIFICATION REMINDER ----------

const expiryCache = new Map<string, { at: number; value: number | null }>()

export async function verificationStatus(user: User): Promise<{ expiresAt: number | null }> {
  if (serverConfig().chain.mode !== 'celo' || !user.rootAddress || !user.connected) return { expiresAt: null }
  const hit = expiryCache.get(user.rootAddress)
  if (hit && Date.now() - hit.at < 60 * 60_000) return { expiresAt: hit.value }
  try {
    const value = await verificationExpiresAt(user.rootAddress)
    expiryCache.set(user.rootAddress, { at: Date.now(), value })
    return { expiresAt: value }
  } catch (err) {
    console.warn('[jobs] verification check failed', err instanceof Error ? err.message : err)
    return { expiresAt: null }
  }
}

export async function verificationReminder(user: User, jobs: AgentJobs): Promise<JobNotice | null> {
  const { expiresAt } = await verificationStatus(user)
  if (!expiresAt) return null
  const left = expiresAt - Date.now()
  if (left > VERIFY_WARN_BEFORE) {
    if (jobs.verifyWarnedAt) await saveJobs(user.id, { verifyWarnedAt: null })
    return null
  }
  if (jobs.verifyWarnedAt && Date.now() - jobs.verifyWarnedAt < VERIFY_REPEAT) return null
  await saveJobs(user.id, { verifyWarnedAt: Date.now() })
  const when = new Intl.DateTimeFormat('en-GB', { timeZone: 'Africa/Lagos', day: 'numeric', month: 'long' }).format(new Date(expiresAt))
  if (left <= 0) {
    return {
      lane: 'save',
      text: 'Your GoodDollar face check has expired, so daily claims are paused',
      message: '⚠️ Your GoodDollar face check has expired, so I can’t claim your daily G$ for now. Open GoodWallet (wallet.gooddollar.org) and verify your face again. It takes a minute, and I’ll start claiming again right after.',
    }
  }
  const days = Math.max(1, Math.ceil(left / DAY))
  return {
    lane: 'save',
    text: `Your GoodDollar face check expires in ${days} day${days === 1 ? '' : 's'} (${when})`,
    message: `⏰ Heads up: your GoodDollar face check expires in ${days} day${days === 1 ? '' : 's'} (${when}). After that I can’t claim your daily G$. Open GoodWallet (wallet.gooddollar.org) and verify again before then, so nothing stops.`,
  }
}

/** Keep proactive messages in the chat history, so a reply ("1B 2C…") has context and web users see them in chat. */
export async function saveToChat(userId: string, text: string) {
  await run('INSERT INTO messages (user_id, role, content, created_at) VALUES (?, ?, ?, ?)', [userId, 'assistant', text, Date.now()])
}

// ---------- runner ----------

/**
 * Run every proactive job that's due. Scheduled runs only act in daytime
 * (7am–9pm Lagos) so nobody gets a drill at 1am; a run the user starts acts now.
 */
export async function runAgentJobs(user: User, opts: { scheduled?: boolean } = {}): Promise<JobNotice[]> {
  if (opts.scheduled) {
    const h = lagosHour()
    if (h < 7 || h >= 21) return []
  }
  const notices: JobNotice[] = []
  for (const job of [verificationReminder, examDrill, opportunityScout]) {
    try {
      const n = await job(user, await getJobs(user.id))
      if (n?.message) await saveToChat(user.id, n.message)
      if (n) notices.push(n)
    } catch (err) {
      console.error('[jobs] failed', job.name, user.id, err)
    }
  }
  return notices
}
