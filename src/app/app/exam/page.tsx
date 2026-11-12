import type { Metadata } from 'next'
import { ExamPrep } from '@/components/ExamPrep'

export const metadata: Metadata = { title: 'Exam prep — Jara' }

export default async function ExamPage({ searchParams }: { searchParams: Promise<{ run?: string; topic?: string }> }) {
  const params = await searchParams
  const id = Number(params.run)
  return <ExamPrep initialRun={Number.isSafeInteger(id) && id > 0 ? id : null} initialTopic={params.topic?.slice(0, 900) ?? ''} />
}
