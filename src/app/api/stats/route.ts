import { NextResponse } from 'next/server'
import { run } from '@/lib/db'

export const dynamic = 'force-dynamic'

// Public numbers for the GoodBuilders shared dashboard: users, transactions, G$ activity.
export async function GET() {
  const [users, connected, acts] = await Promise.all([
    run('SELECT COUNT(*) AS n FROM users'),
    run('SELECT COUNT(*) AS n FROM users WHERE connected = 1'),
    run(`SELECT type, COUNT(*) AS n, COALESCE(SUM(CAST(amount_wei AS REAL)), 0) AS wei, COALESCE(SUM(amount_ngn), 0) AS ngn
         FROM activity WHERE status = 'done' GROUP BY type`),
  ])
  const byType = Object.fromEntries(
    acts.rows.map((r) => [r.type as string, { count: Number(r.n), gd: Math.round(Number(r.wei) / 1e18), ngn: Number(r.ngn) }]),
  )
  return NextResponse.json({
    users: Number(users.rows[0].n),
    connectedUsers: Number(connected.rows[0].n),
    claims: byType.claim ?? { count: 0, gd: 0 },
    billsPaid: byType.pay ?? { count: 0, gd: 0, ngn: 0 },
    rewards: byType.reward ?? { count: 0, gd: 0 },
  })
}
