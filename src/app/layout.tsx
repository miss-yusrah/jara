import type { Metadata, Viewport } from 'next'
import { Bricolage_Grotesque } from 'next/font/google'
import './globals.css'

const bricolage = Bricolage_Grotesque({ variable: '--font-bricolage', subsets: ['latin'], weight: ['400', '500', '600', '700', '800'] })

export const metadata: Metadata = {
  title: 'Jara — your AI agent that puts your G$ to work',
  description:
    'Jara is an AI agent that collects your daily GoodDollar and puts it to work: saves it, pays your light, data and airtime, finds you rewards, and pays for AI help with research, assignments and ideas. No crypto talk.',
}

export const viewport: Viewport = { width: 'device-width', initialScale: 1, themeColor: '#0f3d2a' }

export default function RootLayout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" className={`${bricolage.variable} h-full antialiased`}>
      <body className="min-h-full font-sans">{children}</body>
    </html>
  )
}
