import { NextResponse } from 'next/server'
import { challengeConfig } from '@/lib/daily-challenge'
import { run } from '@/lib/db'

export const dynamic = 'force-dynamic'

// Public audit data contains only already-public wallet addresses, never phone numbers.
export async function GET(req: Request) {
  const { address } = challengeConfig()
  const raw = new URL(req.url).searchParams.get('day')
  const day = Number(raw)
  if (!address || !raw || !Number.isSafeInteger(day))
    return NextResponse.json({ error: 'Draw not found.' }, { status: 404 })
  try {
    const draw = (
      await run(
        'SELECT seed, participants, block_number, block_hash, created_at FROM daily_challenge_draws WHERE contract = ? AND day = ?',
        [address, day],
      )
    ).rows[0]
    if (!draw) return NextResponse.json({ error: 'This draw has not been published yet.' }, { status: 404 })
    const winners = await run(
      'SELECT root, rank, delivered_at FROM daily_challenge_winners WHERE contract = ? AND day = ? ORDER BY rank',
      [address, day],
    )
    return NextResponse.json({
      contract: address,
      day,
      method:
        'Server-generated random seed; sort entrants by keccak256(seed || address), ascending; first five win. Not VRF.',
      seed: draw.seed,
      participants: JSON.parse(String(draw.participants)),
      blockNumber: draw.block_number,
      blockHash: draw.block_hash,
      drawnAt: draw.created_at,
      winners: winners.rows,
    })
  } catch {
    return NextResponse.json({ error: 'Draw results are temporarily unavailable.' }, { status: 503 })
  }
}
