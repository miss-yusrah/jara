// Shared, browser-safe exam format. Generation and scoring are validated on the server.
export const EXAM_QUESTION_COUNT = 20
export const EXAM_OPTIONS = ['WAEC', 'NECO', 'JAMB', 'Post-UTME', 'NABTEB', 'University exams'] as const

export interface ExamQuestion {
  prompt: string
  options: [string, string, string, string]
  correctOption: number
  explanation: string
  topic: string
}

export interface ExamPaper {
  kind: 'exam-practice'
  version: 1
  title: string
  questions: ExamQuestion[]
}

export type ExamAnswer = number | null
export interface ExamSession {
  id: number
  title: string
  questions: Omit<ExamQuestion, 'correctOption' | 'explanation'>[]
  answers: ExamAnswer[]
  currentQuestion: number
  revision: number
  submitted: boolean
  score: number | null
  review: ExamQuestion[] | null
}

const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
const text = (v: unknown, max: number): v is string => typeof v === 'string' && v.trim().length > 0 && v.length <= max
const normalized = (v: string) => v.trim().toLowerCase().replace(/\s+/g, ' ')

export function validateQuestions(value: unknown, count: number): ExamQuestion[] {
  if (!Array.isArray(value) || value.length !== count) throw new Error(`A complete set of ${count} questions is required.`)
  const seen = new Set<string>()
  return value.map((q) => {
    if (!object(q) || !text(q.prompt, 2000) || !text(q.explanation, 2000) || !text(q.topic, 120)
      || !Array.isArray(q.options) || q.options.length !== 4 || !q.options.every((o) => text(o, 1000))
      || !Number.isInteger(q.correctOption) || Number(q.correctOption) < 0 || Number(q.correctOption) > 3) {
      throw new Error('Every question needs four choices, a valid answer, a topic, and an explanation.')
    }
    const key = normalized(q.prompt)
    if (!key || seen.has(key) || new Set(q.options.map(normalized)).size !== 4) throw new Error('Questions and answer choices must be distinct.')
    seen.add(key)
    return { prompt: q.prompt.trim(), options: q.options.map((o: string) => o.trim()) as ExamQuestion['options'], correctOption: Number(q.correctOption), explanation: q.explanation.trim(), topic: q.topic.trim() }
  })
}

export function readExamPaper(output: string): ExamPaper | null {
  try {
    const p: unknown = JSON.parse(output)
    if (!object(p) || p.kind !== 'exam-practice' || p.version !== 1 || !text(p.title, 200)) return null
    return { kind: 'exam-practice', version: 1, title: p.title, questions: validateQuestions(p.questions, EXAM_QUESTION_COUNT) }
  } catch { return null }
}

export function validateExamAnswers(value: unknown, count: number): ExamAnswer[] {
  if (!Array.isArray(value) || value.length !== count || value.some((a) => a !== null && (!Number.isInteger(a) || a < 0 || a > 3))) {
    throw new Error('Choose one of the four options for each question.')
  }
  return value as ExamAnswer[]
}

export function scoreExam(paper: ExamPaper, value: unknown): number {
  const answers = validateExamAnswers(value, paper.questions.length)
  if (answers.some((a) => a === null)) throw new Error('Answer every question before finishing your practice.')
  return paper.questions.reduce((score, q, i) => score + Number(answers[i] === q.correctOption), 0)
}
