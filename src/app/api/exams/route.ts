import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/session'
import { createExam, ExamError, listExamSessions } from '@/lib/exams'
import { requestKey } from '@/lib/money-request'
import { clientIp, rateLimit } from '@/lib/ratelimit'
import { snapshot } from '@/lib/jars'
import { AI_TOOLS } from '@/lib/ai-tools'
import { EXAM_OPTIONS, EXAM_QUESTION_COUNT } from '@/lib/exam-paper'

export const dynamic = 'force-dynamic'
export const maxDuration = 180

export async function GET() {
  const user = await requireUser()
  if (user instanceof NextResponse) return user
  const [sessions, snap] = await Promise.all([listExamSessions(user.id), snapshot(user)])
  return NextResponse.json({ sessions, connected: user.connected, balanceGd: snap.jars.find((j) => j.kind === 'ai')?.balanceGd ?? 0, priceGd: AI_TOOLS.exam.priceGd, questionCount: EXAM_QUESTION_COUNT, exams: EXAM_OPTIONS })
}

export async function POST(req: Request) {
  const user = await requireUser()
  if (user instanceof NextResponse) return user
  if (!user.connected) return NextResponse.json({ error: 'Connect your GoodDollar account first.' }, { status: 400 })
  if (!rateLimit(`exam:${user.id}`, 10, 10 * 60_000) || !rateLimit(`exam-ip:${clientIp(req)}`, 30, 10 * 60_000)) return NextResponse.json({ error: 'Please wait before starting another practice.' }, { status: 429 })
  try {
    const body = await req.json() as { topic?: unknown; requestId?: unknown }
    const id = requestKey(body.requestId)
    if (typeof body.topic !== 'string' || body.topic.length > 1000) throw new ExamError('Enter an exam and subject, up to 1,000 characters.')
    return NextResponse.json(await createExam(user, body.topic, id))
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : 'Could not prepare your practice. Retry the same request.', terminal: err instanceof ExamError && err.terminal }, { status: err instanceof ExamError ? err.status : 400 })
  }
}
