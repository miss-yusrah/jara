import type { Metadata } from 'next'
import { ChallengeAdmin } from './ChallengeAdmin'

export const metadata: Metadata = { title: 'Daily Jara campaign — Jara', robots: { index: false } }
export default function ChallengeAdminPage() {
  return <ChallengeAdmin />
}
