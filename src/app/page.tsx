import Link from 'next/link'
import { Icon, type IconName } from '@/components/Icon'
import { Jar } from '@/components/Jar'
import { botLink } from '@/lib/telegram'

export const dynamic = 'force-dynamic'

const WEEK = [
  { day: 'Mon', icon: 'sun', title: 'Claimed G$ for you', body: 'Shared across your jars before you woke up. AI jar 60%.' },
  { day: 'Tue', icon: 'star', title: 'Your JAMB Biology practice', body: '20 questions, selectable answers and a results review. G$ 50 from your AI jar.' },
  { day: 'Wed', icon: 'sparkle', title: 'Brainstormed your project', body: '8 final-year project ideas in 20 seconds. G$ 150 from your AI jar.' },
  { day: 'Thu', icon: 'chat', title: '3 opportunities found', body: 'A CS internship and two scholarships that fit you, with real links.' },
  { day: 'Fri', icon: 'coins', title: 'Weekly saver bonus', body: 'Claimed 5 days this week: +G$ 400, no forms.' },
  { day: 'Sat', icon: 'flame', title: '7-day streak bonus', body: 'Extra G$ dropped in for showing up all week.' },
  { day: 'Sun', icon: 'chart', title: 'Your weekly wrap', body: '6 drills done, 3 opportunities sent, every claim on time.' },
] as const

const JOBS = [
  { n: '01', t: 'Saves', d: 'Claims your G$ every day and splits it into budgets for light, data and airtime.', c: 'jar-budget-light' },
  { n: '02', t: 'Pays', d: 'Knows when each bill comes round, makes sure the budget is ready and pays, then sends proof.', c: 'jar-budget-data' },
  { n: '03', t: 'Finds rewards', d: 'Streaks, first bills, invites, weekly saving: Jara spots G$ bonuses and collects them.', c: 'jar-budget-airtime' },
  { n: '04', t: 'Powers your AI', d: 'Your G$ pays for AI help: research, assignments, brainstorming, exam practice, CVs and more.', c: 'jar-budget-ai' },
]

const TOOLS = [
  { t: 'Research brief', d: 'Any topic, explained simply', p: 300 },
  { t: 'Assignment helper', d: 'Understand it, get an outline', p: 250 },
  { t: 'Brainstorm', d: 'Ideas for projects & topics', p: 150 },
  { t: 'Exam practice', d: 'WAEC, JAMB, NECO, uni', p: 200 },
  { t: 'CV & cover letter', d: 'Stand out for jobs', p: 400 },
  { t: 'Opportunity search', d: 'Scholarships, internships', p: 300 },
  { t: 'Side-hustle plan', d: 'Start earning, step by step', p: 300 },
  { t: 'Content writer', d: 'Captions, posts, bios', p: 100 },
]

const AUTOMATIONS = [
  {
    icon: 'star',
    t: 'Daily exam prep',
    d: 'Tell it your exam (WAEC, JAMB, NECO, Post-UTME) and the date. Every morning it prepares a full-screen, 20-question practice session. Choose your answers one at a time, then review your score and explanations.',
    p: 'G$ 50 a day',
  },
  {
    icon: 'sparkle',
    t: 'Opportunity scout',
    d: 'Tell it what you’re after. Every 3 days it reads real scholarship, internship and fellowship listings and sends the ones that fit you, with deadlines and the official link.',
    p: 'G$ 50, only when it finds some',
  },
  {
    icon: 'alert',
    t: 'Never miss a claim',
    d: 'It checks your GoodDollar face verification and warns you a week before it expires, so your daily G$ never quietly stops.',
    p: 'Free, always on',
  },
]

const eyebrow = 'text-[11px] font-bold tracking-[0.14em] text-forest/70 uppercase'
const h2 = 'mt-3 max-w-3xl text-[clamp(2rem,5vw,3.25rem)] leading-[1.02] font-semibold tracking-[-0.04em]'
const primary = 'app-button justify-center bg-forest text-cream hover:bg-forest-soft'
const secondary = 'app-button-secondary justify-center'

export default function Home() {
  const tg = botLink()
  return (
    <main className="jara-app overflow-x-hidden text-ink">
      {/* NAV */}
      <header className="app-topbar">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
          <Link href="/" className="flex items-center gap-2.5">
            <span className="grid h-10 w-10 place-items-center rounded-[14px] bg-forest text-crest">
              <Icon name="jar" className="h-5 w-5" />
            </span>
            <span className="text-xl font-bold tracking-tight">jara.</span>
          </Link>
          <Link href="/app" className={primary}>
            Open Jara
          </Link>
        </div>
      </header>

      {/* HERO */}
      <section className="mx-auto max-w-6xl px-4 pt-10 pb-16 sm:px-6 lg:pt-16">
        <p className="inline-flex items-center gap-2 rounded-full bg-[#edf2e8] px-3 py-1.5 text-xs font-bold text-forest">
          <span className="h-1.5 w-1.5 rounded-full bg-forest" /> Powered by GoodDollar · Built on Celo
        </p>
        <div className="mt-6 grid items-end gap-10 lg:grid-cols-[minmax(0,1.15fr)_minmax(0,1fr)]">
          <div>
            <p className={eyebrow}>Meet your AI agent</p>
            <h1 className="mt-3 text-[clamp(3rem,9vw,6rem)] leading-[0.95] font-semibold tracking-[-0.055em]">
              Your G$, <span className="text-forest">put to work.</span>
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-ink/65">
              Jara is an AI agent that quietly handles everyday money for you. It collects your GoodDollar every day and makes it useful: your light, data and airtime,
              bonuses you&apos;d miss, and AI help for school and hustle.
            </p>
            <div className="mt-8 flex flex-col gap-3 sm:flex-row">
              <Link href="/app" className={`${primary} min-h-12 px-6 text-sm`}>
                Get started <Icon name="arrow" className="h-4 w-4" />
              </Link>
              <a href="#start" className={`${secondary} min-h-12 px-6 text-sm`}>
                How it works
              </a>
            </div>
            <p className="mt-4 text-xs font-semibold text-ink/45">In your browser or on Telegram · Clear budgets · G$ payments</p>
          </div>

          {/* A glimpse of the app */}
          <div className="balance-card">
            <div className="relative z-10">
              <p className="text-xs font-semibold text-cream/65">Available to spend</p>
              <p className="mt-3 text-[48px] leading-none font-semibold tracking-[-0.05em] tabular-nums">
                <span className="mr-2 text-[26px] font-medium tracking-normal text-crest">G$</span>19,400
              </p>
              <p className="mt-3 text-sm text-cream/55">≈ ₦2,910 · claimed for you this morning</p>
              <div className="mt-6 grid grid-cols-4 items-end gap-2 rounded-2xl bg-cream/[0.06] px-3 pt-4 pb-2">
                <Jar pct={72} color="crest" lid="#ff6b00" className="h-20" label={{ icon: 'bolt', text: 'Light' }} />
                <Jar pct={45} color="mandarin" className="h-24" label={{ icon: 'signal', text: 'Data' }} />
                <Jar pct={90} color="crest" lid="#ff6b00" className="h-[72px]" label={{ icon: 'phone', text: 'Airtime' }} />
                <Jar pct={60} color="mandarin" lid="#1d5a3f" className="h-[88px]" label={{ icon: 'spark', text: 'AI' }} />
              </div>
            </div>
          </div>
        </div>

        <ul className="mt-12 grid grid-cols-2 gap-3 md:grid-cols-4">
          {['Saves it', 'Pays your bills', 'Finds you rewards', 'Powers your AI'].map((t, i) => (
            <li key={t} className="app-card flex items-center gap-3 px-4 py-3.5 text-sm font-semibold">
              <span className="text-xs font-bold text-forest/50 tabular-nums">0{i + 1}</span> {t}
            </li>
          ))}
        </ul>
      </section>

      {/* START */}
      <section id="start" className="scroll-mt-4 border-y border-ink/8 bg-white py-20">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <p className={eyebrow}>Get started · about 3 minutes</p>
          <h2 className={h2}>Three steps, then Jara takes over.</h2>
          <div className="mt-10 grid gap-4 lg:grid-cols-3">
            <Step n={1} title="Connect your wallet">
              Tap Connect and sign in with Google or email, or use MetaMask or any phone wallet. No seed phrase needed with Google.
            </Step>
            <Step n={2} title="Verify once on GoodDollar">
              GoodDollar gives verified people free G$ every day. If your wallet isn’t verified yet, Jara walks you through the one-time face check right there.
            </Step>
            <Step n={3} title="Approve, then relax">
              Approve two things in your wallet: the link that lets Jara claim your daily G$, and a spending limit for bills and AI. Cancel the limit any time.
            </Step>
          </div>
          <div className="mt-6 grid gap-3 sm:grid-cols-2">
            <p className="rounded-2xl bg-[#f7f8f2] p-5 text-sm leading-relaxed text-ink/65">
              <span className="font-bold text-ink">Prefer chat apps?</span> Everything works in your browser. Add Telegram any time from Getting started and Jara sends your
              morning updates, drills and receipts there too.
            </p>
            <p className="rounded-2xl bg-[#f7f8f2] p-5 text-sm leading-relaxed text-ink/65">
              <span className="font-bold text-ink">New phone or cleared your browser?</span> Connect the same wallet and sign one message. Jara opens your existing account,
              jars and history.
            </p>
          </div>
        </div>
      </section>

      {/* HOW */}
      <section className="py-20">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="grid items-center gap-10 lg:grid-cols-[minmax(0,1fr)_420px]">
            <div>
              <p className={eyebrow}>What it does</p>
              <h2 className={h2}>
                One AI agent. <span className="text-forest">Four jobs.</span> G$ drives all of them.
              </h2>
              <p className="mt-5 max-w-lg text-lg leading-relaxed text-ink/65">
                Jara works while you sleep. Every morning you get one short message saying what it did with your G$, and you don&apos;t have to lift a finger.
              </p>
            </div>
            <div className="app-card p-5">
              <p className="flex items-center gap-1.5 text-xs font-bold text-forest">
                <Icon name="bot" className="h-4 w-4" /> Jara · 7:02am
              </p>
              <p className="mt-2 text-base font-semibold">Morning! While you slept I:</p>
              <ul className="mt-3 grid gap-2 text-sm">
                {(
                  [
                    ['sun', 'Claimed G$ 1,400 into your jars'],
                    ['star', 'Sent your JAMB Biology drill'],
                    ['coins', 'Collected a G$ 400 saver bonus'],
                    ['sparkle', 'AI jar covers 2 research briefs'],
                  ] as const
                ).map(([ic, t]) => (
                  <li key={t} className="flex items-center gap-2.5">
                    <span className="grid h-7 w-7 shrink-0 place-items-center rounded-lg bg-[#edf2e8] text-forest">
                      <Icon name={ic} className="h-3.5 w-3.5" strokeWidth={2.5} />
                    </span>
                    {t}
                  </li>
                ))}
              </ul>
            </div>
          </div>
          <div className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {JOBS.map((s) => (
              <div key={s.n} className={`jar-budget ${s.c} p-5`}>
                <p className="text-xs font-bold text-ink/40 tabular-nums">{s.n}</p>
                <p className="mt-4 text-lg font-semibold tracking-tight">{s.t}</p>
                <p className="mt-2 text-sm leading-relaxed text-ink/60">{s.d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* WEEK */}
      <section className="border-y border-ink/8 bg-white py-20">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
            <div>
              <p className={eyebrow}>A week with Jara</p>
              <h2 className={h2}>Small, daily, useful.</h2>
            </div>
            <p className="max-w-sm text-sm leading-relaxed text-ink/60">Claims, AI payments and bonuses are real G$ transactions on Celo.</p>
          </div>
          <div className="mt-10 grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
            {WEEK.map((w, i) => (
              <div key={w.day} className={`app-card p-5 ${i === 0 ? 'lg:col-span-2' : ''}`}>
                <div className="flex items-center justify-between">
                  <span className="rounded-full bg-[#f4f5ef] px-2.5 py-1 text-[10px] font-bold tracking-wider text-ink/50 uppercase">{w.day}</span>
                  <span className="grid h-9 w-9 place-items-center rounded-xl bg-[#edf2e8] text-forest">
                    <Icon name={w.icon as IconName} className="h-4 w-4" />
                  </span>
                </div>
                <p className="mt-5 text-base font-semibold tracking-tight">{w.title}</p>
                <p className="mt-1.5 text-sm leading-relaxed text-ink/55">{w.body}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* AI */}
      <section className="py-20">
        <div className="mx-auto grid max-w-6xl items-center gap-10 px-4 sm:px-6 lg:grid-cols-[1fr_1.1fr]">
          <div>
            <p className={eyebrow}>For students &amp; young people</p>
            <h2 className={h2}>
              Your G$ pays for <span className="text-forest">your AI.</span>
            </h2>
            <p className="mt-5 max-w-lg text-lg leading-relaxed text-ink/65">
              No card, no subscription. The G$ you collect every day fills your AI jar, and each time you ask for help, Jara pays for the AI with it.
            </p>
            <p className="mt-3 max-w-lg text-sm text-ink/45">For assignments, Jara helps you understand and plan. You still write it in your own words.</p>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {TOOLS.map((x) => (
              <div key={x.t} className="app-card p-4">
                <div className="flex items-start justify-between gap-2">
                  <p className="text-sm leading-tight font-semibold">{x.t}</p>
                  <span className="shrink-0 rounded-full bg-[#edf2e8] px-2 py-0.5 text-[10px] font-bold text-forest tabular-nums">G$ {x.p}</span>
                </div>
                <p className="mt-1.5 text-xs text-ink/55">{x.d}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ON ITS OWN */}
      <section className="border-y border-ink/8 bg-white py-20">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="flex flex-col justify-between gap-4 sm:flex-row sm:items-end">
            <div>
              <p className={eyebrow}>Automations</p>
              <h2 className={h2}>
                It doesn&apos;t wait <span className="text-forest">to be asked.</span>
              </h2>
            </div>
            <p className="max-w-sm text-sm leading-relaxed text-ink/60">
              A chatbot answers when you type. Jara is an agent: switch a job on once and it keeps doing it, in the app or on Telegram.
            </p>
          </div>
          <div className="mt-10 grid gap-3 lg:grid-cols-3">
            {AUTOMATIONS.map((x) => (
              <div key={x.t} className="app-card p-6">
                <span className="grid h-10 w-10 place-items-center rounded-xl bg-[#edf2e8] text-forest">
                  <Icon name={x.icon as IconName} className="h-5 w-5" />
                </span>
                <p className="mt-5 text-lg font-semibold tracking-tight">{x.t}</p>
                <p className="mt-2 text-sm leading-relaxed text-ink/60">{x.d}</p>
                <p className="mt-4 inline-block rounded-full bg-[#f4f5ef] px-3 py-1 text-xs font-bold text-ink/60">{x.p}</p>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* CHAT */}
      <section className="py-20">
        <div className="mx-auto grid max-w-6xl items-center gap-10 px-4 sm:px-6 lg:grid-cols-2">
          <div>
            <p className={eyebrow}>English or Pidgin</p>
            <h2 className={h2}>
              Talk to it like <span className="text-forest">your person.</span>
            </h2>
            <p className="mt-5 max-w-lg text-lg leading-relaxed text-ink/65">
              Tell Jara what you need, in the app or on Telegram, and it tells you what it costs before it spends a single G$.
            </p>
          </div>
          <div className="app-card space-y-3 p-5">
            <Bubble me>My JAMB na 5 May. Biology and Chemistry. Abeg help me prepare</Bubble>
            <Bubble>I fit send you a full 20-question practice every morning till 5 May, Biology and Chemistry in turn. Pick your answers for the full-screen prep, then see your score. Na G$ 50 each from your AI jar. Make I start?</Bubble>
            <Bubble me>Yes o</Bubble>
            <Bubble>Done ✅ Your Biology practice dey ready. Open the link, choose your answers, and see your score at the end. 📚</Bubble>
          </div>
        </div>
      </section>

      {/* CTA */}
      <section className="px-4 pb-20 sm:px-6">
        <div className="balance-card mx-auto max-w-6xl px-6 py-14 text-center sm:py-16">
          <div className="relative z-10">
            <h2 className="mx-auto max-w-2xl text-[clamp(2rem,5vw,3.5rem)] leading-[1.02] font-semibold tracking-[-0.045em]">Let your G$ do the boring part.</h2>
            <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
              <Link href="/app" className="app-button min-h-12 justify-center bg-crest px-6 text-sm text-ink hover:bg-crest-soft">
                Get started in your browser <Icon name="arrow" className="h-4 w-4" />
              </Link>
              {tg && (
                <a href={tg} className="app-button min-h-12 justify-center border border-cream/20 bg-cream/10 px-6 text-sm text-cream hover:bg-cream/15">
                  Start on Telegram
                </a>
              )}
            </div>
          </div>
        </div>
      </section>

      <footer className="border-t border-ink/8 py-8 text-ink/50">
        <div className="mx-auto flex max-w-6xl flex-col items-center justify-between gap-3 px-4 text-xs font-semibold sm:flex-row sm:px-6">
          <p className="flex items-center gap-2">
            <Icon name="jar" className="h-4 w-4" /> Jara · GoodBuilders Season 5
          </p>
          <p className="text-center">
            Built on GoodDollar &amp; Celo · Brain on AntSeed · by Calbridge Digital Labs ·{' '}
            <a href="https://github.com/miss-yusrah/jara" target="_blank" rel="noreferrer" className="underline hover:text-ink">
              GitHub
            </a>
          </p>
        </div>
      </footer>
    </main>
  )
}

function Step({ n, title, children }: { n: number; title: string; children: React.ReactNode }) {
  return (
    <div className="app-card p-6">
      <span className="grid h-9 w-9 place-items-center rounded-full bg-forest text-sm font-bold text-cream">{n}</span>
      <p className="mt-5 text-lg font-semibold tracking-tight">{title}</p>
      <p className="mt-2 text-sm leading-relaxed text-ink/60">{children}</p>
    </div>
  )
}

function Bubble({ children, me }: { children: React.ReactNode; me?: boolean }) {
  return (
    <div className={`flex ${me ? 'justify-end' : ''}`}>
      <p className={`max-w-[85%] rounded-2xl px-4 py-3 text-sm leading-snug ${me ? 'rounded-br-md bg-forest text-cream' : 'rounded-bl-md bg-[#f4f5ef] text-ink'}`}>{children}</p>
    </div>
  )
}
