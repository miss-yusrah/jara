import { redirect } from 'next/navigation'

// The leaderboard is a pop-up on the game page now; old links open it there.
export default function StreakLeaderboard() {
  redirect('/app/streak?view=leaderboard')
}
