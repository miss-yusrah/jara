import { AI_TOOLS, runPaidJob } from './ai-tools'
import { atomic, run } from './db'
import { generateExamPaper } from './exam-generator'
import { readExamPaper, scoreExam, validateExamAnswers, type ExamSession } from './exam-paper'
import type { User } from './users'

export class ExamError extends Error {
  constructor(message: string, public status = 400, public terminal = false) { super(message) }
}

export async function examRunId(userId: string, output: string): Promise<number> {
  const r = await run("SELECT id FROM ai_runs WHERE user_id = ? AND tool = 'exam' AND output = ? AND demo = 0 ORDER BY id DESC LIMIT 1", [userId, output])
  if (!r.rows[0]) throw new ExamError('Your practice is still being saved. Retry this same request.', 409)
  return Number(r.rows[0].id)
}

export async function createExam(user: User, topic: string, requestId: string) {
  const input = topic.trim().slice(0, 1000)
  if (input.length < 3) throw new ExamError('Tell us the exam and subject you want to practise.')
  const result = await runPaidJob(user, {
    requestId, tool: 'exam', title: `Exam practice: ${input.slice(0, 60)}`, input,
    priceGd: AI_TOOLS.exam.priceGd, produce: () => generateExamPaper(input),
  })
  if (!result.ok) {
    const message = result.reason === 'funds' ? 'Your AI jar needs G$ 200 for a new practice session.'
      : result.reason === 'payment' ? 'Your payment is awaiting confirmation. Retry this same request to open the saved practice.'
      : result.reason === 'failed' ? 'Payment failed without transferring G$. Start a new request to try again.'
      : 'A complete practice paper could not be prepared. No payment was started. Try again.'
    throw new ExamError(message, result.reason === 'payment' ? 409 : 400, result.reason === 'failed')
  }
  return { id: await examRunId(user.id, result.output), costGd: result.costGd }
}

async function ownedPaper(userId: string, id: number) {
  if (!Number.isSafeInteger(id) || id < 1) throw new ExamError('Practice session not found.', 404)
  const row = (await run("SELECT output FROM ai_runs WHERE id = ? AND user_id = ? AND tool = 'exam' AND demo = 0", [id, userId])).rows[0]
  if (!row) throw new ExamError('Practice session not found.', 404)
  const paper = readExamPaper(String(row.output))
  if (!paper) throw new ExamError('This older drill is text only. Start a new full practice session.', 422)
  return paper
}

export async function getExamSession(userId: string, id: number): Promise<ExamSession> {
  const paper = await ownedPaper(userId, id)
  const attempt = (await run('SELECT * FROM exam_attempts WHERE run_id = ? AND user_id = ?', [id, userId])).rows[0]
  const answers = attempt ? validateExamAnswers(JSON.parse(String(attempt.answers)), paper.questions.length) : paper.questions.map(() => null)
  const submitted = Boolean(attempt?.submitted_at)
  return {
    id, title: paper.title,
    questions: paper.questions.map(({ prompt, options, topic }) => ({ prompt, options, topic })),
    answers, currentQuestion: Number(attempt?.current_question ?? 0), revision: Number(attempt?.revision ?? 0), submitted,
    score: submitted ? scoreExam(paper, answers) : null,
    review: submitted ? paper.questions : null,
  }
}

export async function saveExamSession(userId: string, id: number, input: { answers?: unknown; currentQuestion?: unknown; revision?: unknown; submit?: unknown; restart?: unknown }) {
  const paper = await ownedPaper(userId, id)
  if (!Number.isInteger(input.revision) || Number(input.revision) < 0) throw new ExamError('Reload this practice session before continuing.', 409)
  const restart = input.restart === true
  const answers = restart ? paper.questions.map(() => null) : validateExamAnswers(input.answers, paper.questions.length)
  const current = restart ? 0 : input.currentQuestion
  if (!Number.isInteger(current) || Number(current) < 0 || Number(current) >= paper.questions.length) throw new ExamError('Unknown question.')
  const submit = !restart && input.submit === true
  if (submit) scoreExam(paper, answers)
  await atomic(async (tx) => {
    await tx.execute({ sql: 'INSERT OR IGNORE INTO exam_attempts(run_id, user_id) VALUES (?, ?)', args: [id, userId] })
    const saved = (await tx.execute({ sql: 'SELECT * FROM exam_attempts WHERE run_id = ? AND user_id = ?', args: [id, userId] })).rows[0]
    if (Number(saved.revision) !== input.revision) {
      // A lost response may repeat a save; identical state can be acknowledged safely.
      if (!restart && saved.answers === JSON.stringify(answers) && Number(saved.current_question) === current && Boolean(saved.submitted_at) === submit) return
      throw new ExamError('This practice changed in another tab. Reload to continue with your saved answers.', 409)
    }
    if (saved.submitted_at && !restart) throw new ExamError('This practice is already finished. Choose Try again to retake it.', 409)
    await tx.execute({ sql: 'UPDATE exam_attempts SET answers = ?, current_question = ?, submitted_at = ?, revision = revision + 1 WHERE run_id = ? AND user_id = ?', args: [JSON.stringify(answers), Number(current), submit ? Date.now() : null, id, userId] })
  })
  return getExamSession(userId, id)
}

export async function listExamSessions(userId: string) {
  const rows = (await run(`SELECT a.id, a.output, a.cost_gd, a.created_at, e.answers, e.submitted_at
    FROM ai_runs a LEFT JOIN exam_attempts e ON e.run_id = a.id AND e.user_id = a.user_id
    WHERE a.user_id = ? AND a.tool = 'exam' AND a.demo = 0 ORDER BY a.id DESC LIMIT 40`, [userId])).rows
  return rows.flatMap((r) => {
    const p = readExamPaper(String(r.output))
    if (!p) return []
    const answers = r.answers ? validateExamAnswers(JSON.parse(String(r.answers)), p.questions.length) : []
    return [{ id: Number(r.id), title: p.title, count: p.questions.length, answered: answers.filter((a) => a !== null).length, submitted: Boolean(r.submitted_at), costGd: Number(r.cost_gd), createdAt: Number(r.created_at) }]
  })
}
