import type { Metadata } from 'next'
import { AiChat } from '@/components/AiChat'

export const metadata: Metadata = { title: 'Jara AI — research, assignments and more, paid with G$' }

export default function AiPage() {
  return <AiChat />
}
