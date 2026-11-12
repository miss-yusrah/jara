'use client'

import Link from 'next/link'
import { Icon, type IconName } from './Icon'

export type DashboardView = 'overview' | 'automations' | 'rewards' | 'chat' | 'guide'

const items: { id: DashboardView; label: string; icon: IconName }[] = [
  { id: 'overview', label: 'Overview', icon: 'chart' },
  { id: 'automations', label: 'Automations', icon: 'bot' },
  { id: 'rewards', label: 'Rewards', icon: 'star' },
  { id: 'chat', label: 'Ask Jara', icon: 'chat' },
]

export function dashboardView(): DashboardView {
  if (typeof window === 'undefined') return 'overview'
  const hash = window.location.hash.slice(1)
  return [...items.map((item) => item.id), 'guide'].includes(hash) ? hash as DashboardView : 'overview'
}

export function DashboardNav({ active, onSelect, onWallet }: { active: DashboardView; onSelect: (view: DashboardView) => void; onWallet: () => void }) {
  return (
    <aside className="dashboard-sidebar">
      <div className="hidden lg:block">
        <p className="px-3 text-[11px] font-bold tracking-[0.16em] text-ink/45 uppercase">Your everyday companion</p>
      </div>
      <nav aria-label="Main navigation" className="dashboard-nav">
        {items.map((item) => (
          <a key={item.id} href={`#${item.id}`} aria-current={active === item.id ? 'page' : undefined}
            onClick={(event) => { event.preventDefault(); onSelect(item.id) }}
            className={`dashboard-nav-item ${active === item.id ? 'is-active' : ''}`}>
            <Icon name={item.icon} className="h-5 w-5" strokeWidth={1.8} />
            <span>{item.label}</span>
            {active === item.id && <span className="ml-auto hidden h-1.5 w-1.5 rounded-full bg-forest lg:block" />}
          </a>
        ))}
      </nav>
      <div className="mt-7 hidden border-t border-ink/10 pt-5 lg:grid lg:gap-1">
        <Link href="/app/ai" className="dashboard-nav-item"><Icon name="sparkle" className="h-5 w-5" strokeWidth={1.8} /> Jara AI <span className="ml-auto text-xs">↗</span></Link>
        <Link href="/app/exam" className="dashboard-nav-item"><Icon name="star" className="h-5 w-5" strokeWidth={1.8} /> Exam prep <span className="ml-auto text-xs">↗</span></Link>
        <button onClick={onWallet} className="dashboard-nav-item"><Icon name="coins" className="h-5 w-5" strokeWidth={1.8} /> Your wallet</button>
        <a href="#guide" onClick={(event) => { event.preventDefault(); onSelect('guide') }} aria-current={active === 'guide' ? 'page' : undefined} className={`dashboard-nav-item ${active === 'guide' ? 'is-active' : ''}`}><Icon name="sun" className="h-5 w-5" strokeWidth={1.8} /> Getting started</a>
      </div>
      <div className="mt-auto hidden px-3 pt-16 lg:block">
        <div className="mb-3 flex items-center gap-2 text-sm font-bold text-forest"><span className="h-2 w-2 rounded-full bg-forest" /> A little, every day.</div>
        <p className="text-xs leading-relaxed text-ink/50">Your GoodDollar.<br />More possibilities.</p>
      </div>
    </aside>
  )
}
