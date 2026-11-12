import { apiFailure } from '@/lib/api-error'
import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/session'
import { ExamError, getExamSession, saveExamSession } from '@/lib/exams'

export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ id: string }> }
const failure = (err: unknown) => err instanceof ExamError
  ? NextResponse.json({ error: err.message, terminal: err.terminal }, { status: err.status })
  : apiFailure(err, 'exam-session')

async function get(_req: Request, context: Context) {
  const user = await requireUser()
  if (user instanceof NextResponse) return user
  try { return NextResponse.json(await getExamSession(user.id, Number((await context.params).id))) } catch (err) { return failure(err) }
}

async function put(req: Request, context: Context) {
  const user = await requireUser()
  if (user instanceof NextResponse) return user
  try {
    const body = await req.json().catch(() => null)
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ExamError('Invalid practice update.')
    return NextResponse.json(await saveExamSession(user.id, Number((await context.params).id), body))
  } catch (err) { return failure(err) }
}

export async function GET(req: Request, context: Context) {
  try { return await get(req, context) } catch (err) { return apiFailure(err, 'exams/[id]') }
}

export async function PUT(req: Request, context: Context) {
  try { return await put(req, context) } catch (err) { return apiFailure(err, 'exams/[id]') }
}
