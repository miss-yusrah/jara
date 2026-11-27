// Jara Streak scoring, shared by the server (which scores) and the game screen (which explains).

/** Time for the next question: 7 seconds, 0.2s less for every answer in the streak, never under 4. */
export function questionMs(streak: number): number {
  return Math.max(4_000, 7_000 - streak * 200)
}

/** Combo multiplier once the streak reaches this many correct answers in a row. */
export function multiplier(streak: number): number {
  return streak >= 20 ? 4 : streak >= 10 ? 3 : streak >= 5 ? 2 : 1
}

/** Points for one correct answer: 100, plus up to 50 for speed, times the combo, doubled in Golden Hour. */
export function points(elapsedMs: number, limitMs: number, streakAfter: number, golden: boolean): number {
  const speed = Math.round(50 * Math.max(0, 1 - elapsedMs / limitMs))
  return (100 + speed) * multiplier(streakAfter) * (golden ? 2 : 1)
}

/** The bounty runs on Lagos time (WAT, UTC+1, no daylight saving): daily runs reset at midnight there. */
export function lagosDay(ms: number): string {
  return new Date(ms + 3_600_000).toISOString().slice(0, 10)
}
