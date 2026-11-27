'use client'

import Link from 'next/link'
import { useCallback, useState } from 'react'
import { createPortal } from 'react-dom'
import { Icon, type IconName } from './Icon'
import { useSheetDialog } from './useSheetDialog'

export type DashboardView = 'overview' | 'automations' | 'rewards' | 'chat' | 'guide' | 'vote'

const items: { id: DashboardView; label: string; icon: IconName }[] = [
  { id: 'overview', label: 'Overview', icon: 'chart' },
  { id: 'automations', label: 'Automations', icon: 'bot' },
  { id: 'rewards', label: 'Rewards', icon: 'star' },
  { id: 'chat', label: 'Ask Jara', icon: 'chat' },
]

export function dashboardView(): DashboardView {
  if (typeof window === 'undefined') return 'overview'
  const hash = window.location.hash.slice(1)
  return [...items.map((item) => item.id), 'guide', 'vote'].includes(hash) ? hash as DashboardView : 'overview'
}

type Props = { active: DashboardView; onSelect: (view: DashboardView) => void; onWallet: () => void }

export function DashboardNav({ active, onSelect, onWallet }: Props) {
  const [more, setMore] = useState(false)
  const closeMore = useCallback(() => setMore(false), [])
  const tab = (item: { id: DashboardView; label: string; icon: IconName }, className = '') => (
    <a key={item.id} href={`#${item.id}`} aria-current={active === item.id ? 'page' : undefined}
      onClick={(event) => { event.preventDefault(); onSelect(item.id) }}
      className={`dashboard-nav-item ${active === item.id ? 'is-active' : ''} ${className}`}>
      <Icon name={item.icon} className="h-5 w-5" strokeWidth={1.8} />
      <span>{item.label}</span>
      {active === item.id && <span className="ml-auto hidden h-1.5 w-1.5 rounded-full bg-forest lg:block" />}
    </a>
  )
  // Behind "More" on phones: everything that doesn't fit in the bottom bar.
  const inMore = active === 'chat' || active === 'guide' || active === 'vote'
  return (
    <aside className="dashboard-sidebar">
      <div className="hidden lg:block">
        <p className="px-3 text-[11px] font-bold tracking-[0.16em] text-ink/45 uppercase">Your everyday companion</p>
      </div>
      <nav aria-label="Main navigation" className="dashboard-nav">
        {tab(items[0])}
        {tab(items[1])}
        {/* Phones: Jara AI gets the middle slot; Ask Jara moves into More. */}
        <Link href="/app/ai" className="dashboard-nav-item nav-phone-only"><Icon name="sparkle" className="h-5 w-5" strokeWidth={1.8} /><span>Jara AI</span></Link>
        {tab(items[2])}
        {tab(items[3], 'nav-desktop-only')}
        <button type="button" onClick={() => setMore(true)} aria-haspopup="dialog" aria-expanded={more}
          className={`dashboard-nav-item nav-phone-only ${inMore ? 'is-active' : ''}`}>
          <Icon name="menu" className="h-5 w-5" strokeWidth={1.8} /><span>More</span>
        </button>
      </nav>
      <div className="mt-7 hidden border-t border-ink/10 pt-5 lg:grid lg:gap-1">
        <Link href="/app/ai" className="dashboard-nav-item"><Icon name="sparkle" className="h-5 w-5" strokeWidth={1.8} /> Jara AI <span className="ml-auto text-xs">↗</span></Link>
        <Link href="/app/exam" className="dashboard-nav-item"><Icon name="star" className="h-5 w-5" strokeWidth={1.8} /> Exam prep <span className="ml-auto text-xs">↗</span></Link>
        <Link href="/app/streak" className="dashboard-nav-item"><Icon name="flame" className="h-5 w-5" strokeWidth={1.8} /> Jara Streak <span className="ml-auto text-xs">↗</span></Link>
        <button onClick={onWallet} className="dashboard-nav-item"><Icon name="coins" className="h-5 w-5" strokeWidth={1.8} /> Your wallet</button>
        <a href="#guide" onClick={(event) => { event.preventDefault(); onSelect('guide') }} aria-current={active === 'guide' ? 'page' : undefined} className={`dashboard-nav-item ${active === 'guide' ? 'is-active' : ''}`}><Icon name="sun" className="h-5 w-5" strokeWidth={1.8} /> Getting started</a>
        <a href="#vote" onClick={(event) => { event.preventDefault(); onSelect('vote') }} aria-current={active === 'vote' ? 'page' : undefined} className={`dashboard-nav-item ${active === 'vote' ? 'is-active' : ''}`}><Icon name="check" className="h-5 w-5" strokeWidth={1.8} /> Vote for Jara</a>
      </div>
      <div className="mt-auto hidden px-3 pt-16 lg:block">
        <div className="mb-3 flex items-center gap-2 text-sm font-bold text-forest"><span className="h-2 w-2 rounded-full bg-forest" /> A little, every day.</div>
        <p className="text-xs leading-relaxed text-ink/50">Your GoodDollar.<br />More possibilities.</p>
      </div>
      {/* Portalled: the bar's backdrop blur would otherwise trap a fixed sheet inside it. */}
      {more && createPortal(<MoreSheet active={active} onClose={closeMore} onSelect={(view) => { closeMore(); onSelect(view) }} onWallet={() => { closeMore(); onWallet() }} />, document.body)}
    </aside>
  )
}

function MoreSheet({ active, onClose, onSelect, onWallet }: Props & { onClose: () => void }) {
  const ref = useSheetDialog(onClose)
  const row = 'flex min-h-14 w-full items-center gap-4 rounded-2xl px-4 text-left text-base font-bold text-ink hover:bg-[#eaf0e4]'
  const current = (view: DashboardView) => (active === view ? 'bg-[#e5eddc] text-forest' : '')
  return (
    <div className="fixed inset-0 z-50 flex items-end bg-ink/30 lg:hidden" onClick={onClose}>
      <div ref={ref} role="dialog" aria-modal="true" aria-label="More" tabIndex={-1} onClick={(event) => event.stopPropagation()}
        className="w-full rounded-t-3xl bg-cream px-4 pt-3 pb-[max(16px,env(safe-area-inset-bottom))] shadow-2xl outline-none">
        <div className="mx-auto mb-3 h-1.5 w-10 rounded-full bg-ink/15" />
        <div className="flex items-center justify-between px-2 pb-2">
          <h2 className="text-lg font-bold tracking-tight">More</h2>
          <button type="button" onClick={onClose} aria-label="Close" className="grid h-10 w-10 place-items-center rounded-full hover:bg-ink/5"><Icon name="x" className="h-5 w-5" /></button>
        </div>
        <div className="grid gap-1">
          <button type="button" onClick={() => onSelect('chat')} className={`${row} ${current('chat')}`}><Icon name="chat" className="h-5 w-5 text-forest" /> <span>Ask Jara<span className="block text-xs font-semibold text-ink/50">Airtime, bills and your requests</span></span></button>
          <Link href="/app/streak" className={row}><Icon name="flame" className="h-5 w-5 text-mandarin" /> <span>Jara Streak<span className="block text-xs font-semibold text-ink/50">The campus bounty game</span></span></Link>
          <Link href="/app/exam" className={row}><Icon name="star" className="h-5 w-5 text-forest" /> Exam prep</Link>
          <button type="button" onClick={onWallet} className={row}><Icon name="coins" className="h-5 w-5 text-forest" /> Your wallet</button>
          <button type="button" onClick={() => onSelect('guide')} className={`${row} ${current('guide')}`}><Icon name="sun" className="h-5 w-5 text-forest" /> Getting started</button>
          <button type="button" onClick={() => onSelect('vote')} className={`${row} ${current('vote')}`}><Icon name="check" className="h-5 w-5 text-forest" /> Vote for Jara</button>
        </div>
      </div>
    </div>
  )
}
