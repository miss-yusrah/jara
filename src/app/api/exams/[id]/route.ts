import { NextResponse } from 'next/server'
import { requireUser } from '@/lib/session'
import { ExamError, getExamSession, saveExamSession } from '@/lib/exams'

export const dynamic = 'force-dynamic'
type Context = { params: Promise<{ id: string }> }
const failure = (err: unknown) => NextResponse.json({ error: err instanceof Error ? err.message : 'Could not save your practice.' }, { status: err instanceof ExamError ? err.status : 400 })

export async function GET(_req: Request, context: Context) {
  const user = await requireUser()
  if (user instanceof NextResponse) return user
  try { return NextResponse.json(await getExamSession(user.id, Number((await context.params).id))) } catch (err) { return failure(err) }
}

export async function PUT(req: Request, context: Context) {
  const user = await requireUser()
  if (user instanceof NextResponse) return user
  try {
    const body = await req.json()
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new ExamError('Invalid practice update.')
    return NextResponse.json(await saveExamSession(user.id, Number((await context.params).id), body))
  } catch (err) { return failure(err) }
}
