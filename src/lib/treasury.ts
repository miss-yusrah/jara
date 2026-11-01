import { run } from './db'
import { AI_TOOLS, isAiTool } from './ai-tools'
import { ngnPerGd, usdPerGd } from './price'

// Operator view: USDC put into AntSeed vs the G$ users paid for AI helpers.

export async function addTopup(amountUsd: number, note?: string) {
  if (!Number.isFinite(amountUsd) || amountUsd <= 0) throw new Error('amount must be positive')
  await run('INSERT INTO treasury_topups (amount_usd, note, created_at) VALUES (?, ?, ?)', [amountUsd, note?.slice(0, 200) ?? null, Date.now()])
}

export async function deleteTopup(id: number) {
  await run('DELETE FROM treasury_topups WHERE id = ?', [id])
}

export async function treasuryReport() {
  const [ai, perTool, bills, topups, users] = await Promise.all([
    run(`SELECT COUNT(*) AS n, COALESCE(SUM(cost_gd), 0) AS gd FROM ai_runs WHERE demo = 0`),
    run(`SELECT tool, COUNT(*) AS n, COALESCE(SUM(cost_gd), 0) AS gd FROM ai_runs WHERE demo = 0 GROUP BY tool ORDER BY gd DESC`),
    run(`SELECT COUNT(*) AS n, COALESCE(SUM(CAST(amount_wei AS REAL)), 0) AS wei, COALESCE(SUM(amount_ngn), 0) AS ngn FROM activity WHERE type = 'pay' AND status = 'done'`),
    run(`SELECT id, amount_usd, note, created_at FROM treasury_topups ORDER BY id DESC`),
    run(`SELECT COUNT(DISTINCT user_id) AS n FROM ai_runs WHERE demo = 0`),
  ])
  const [usd, ngn] = await Promise.all([usdPerGd(), ngnPerGd()])
  const aiGd = Number(ai.rows[0].gd)
  const putInUsd = topups.rows.reduce((s, r) => s + Number(r.amount_usd), 0)
  const recoupedUsd = aiGd * usd
  return {
    rates: { usdPerGd: usd, ngnPerGd: ngn },
    ai: {
      uses: Number(ai.rows[0].n),
      users: Number(users.rows[0].n),
      gd: aiGd,
      usd: recoupedUsd,
      ngn: aiGd * ngn,
      perTool: perTool.rows.map((r) => ({
        tool: r.tool as string,
        name: isAiTool(r.tool) ? AI_TOOLS[r.tool].name : String(r.tool),
        uses: Number(r.n),
        gd: Number(r.gd),
      })),
    },
    antseed: {
      putInUsd,
      recoupedUsd,
      recoupedPct: putInUsd > 0 ? Math.round((recoupedUsd / putInUsd) * 1000) / 10 : null,
      stillOwedUsd: Math.max(0, putInUsd - recoupedUsd),
      topups: topups.rows.map((r) => ({ id: Number(r.id), amountUsd: Number(r.amount_usd), note: (r.note as string) ?? '', createdAt: Number(r.created_at) })),
    },
    bills: { count: Number(bills.rows[0].n), gd: Math.round(Number(bills.rows[0].wei) / 1e18), ngn: Number(bills.rows[0].ngn) },
  }
}
