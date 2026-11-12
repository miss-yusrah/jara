import { NextResponse } from 'next/server'
import { run } from '@/lib/db'
import { requireUser } from '@/lib/session'
import { readExamPaper } from '@/lib/exam-paper'

export const dynamic = 'force-dynamic'

// Everything the agent sent on its own (exam drills, opportunity lists), newest first.
export async function GET() {
  const user = await requireUser()
  if (user instanceof NextResponse) return user
  const r = await run(
    "SELECT id, tool, input, output, cost_gd, created_at FROM ai_runs WHERE user_id = ? AND input LIKE '[agent]%' ORDER BY id DESC LIMIT 40",
    [user.id],
  )
  return NextResponse.json({
    items: r.rows.map((x) => ({
      id: Number(x.id),
      kind: x.tool === 'opportunities' ? 'scout' : 'drill',
      title: String(x.input).replace(/^\[agent\]\s*/, ''),
      output: String(x.output),
      examHref: x.tool === 'exam' && readExamPaper(String(x.output)) ? `/app/exam?run=${Number(x.id)}` : null,
      costGd: Number(x.cost_gd),
      createdAt: Number(x.created_at),
    })),
  })
}
