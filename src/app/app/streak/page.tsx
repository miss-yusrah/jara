import type { Metadata } from 'next'
import { StreakGame } from '@/components/StreakGame'

export const metadata: Metadata = { title: 'Jara Streak — Campus Bounty' }

export default function StreakPage() {
  return <StreakGame />
}
