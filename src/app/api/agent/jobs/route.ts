import { NextResponse } from 'next/server'
import { setExamPrep, setScout } from '@/lib/agent'
import { saveJobs, saveToChat } from '@/lib/agent/jobs'
import { clientIp, rateLimit } from '@/lib/ratelimit'
import { requireUser } from '@/lib/session'
import { sendMessage } from '@/lib/telegram'
import { getUserById } from '@/lib/users'
import { bad, userState } from '../../_shared'

export const dynamic = 'force-dynamic'

// Switch the agent's proactive jobs on or off: daily exam drills and the opportunity scout.
export async function POST(req: Request) {
  const user = await requireUser()
  if (user instanceof NextResponse) return user
  if (!rateLimit(`jobs:${user.id}`, 20, 10 * 60_000) || !rateLimit(`jobs-ip:${clientIp(req)}`, 60, 10 * 60_000)) {
    return NextResponse.json({ error: 'Too many changes — try again in a few minutes.' }, { status: 429 })
  }
  if (!user.connected) return bad('Connect your GoodDollar account first.')
  const body = (await req.json().catch(() => ({}))) as {
    job?: 'exam' | 'scout'
    on?: boolean
    exam?: string
    subjects?: string
    examDate?: string
    interests?: string
  }

  let sent: string | undefined
  if (body.job === 'exam') {
    if (body.on === false) await saveJobs(user.id, { examOn: false })
    else {
      const r = await setExamPrep(user, { exam: body.exam, subjects: body.subjects, examDate: body.examDate })
      if ('error' in r) return bad(r.error.charAt(0).toUpperCase() + r.error.slice(1))
      sent = r.sent
    }
  } else if (body.job === 'scout') {
    if (body.on === false) await saveJobs(user.id, { scoutOn: false })
    else {
      const r = await setScout(user, body.interests)
      if ('error' in r) return bad(r.error.charAt(0).toUpperCase() + r.error.slice(1))
      sent = r.sent
    }
  } else return bad('Unknown job')

  if (sent) await saveToChat(user.id, sent)
  if (sent && user.tgChatId) await sendMessage(user.tgChatId, sent).catch(() => null)
  return NextResponse.json({ sent: sent ?? null, state: await userState((await getUserById(user.id))!) })
}
