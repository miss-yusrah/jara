// One consistent icon set: 24px grid, 2.25 stroke, round caps. Inherits currentColor.

export type IconName =
  | 'jar'
  | 'sun'
  | 'chat'
  | 'sparkle'
  | 'bolt'
  | 'star'
  | 'flame'
  | 'chart'
  | 'check'
  | 'x'
  | 'bot'
  | 'plus'
  | 'undo'
  | 'arrow'
  | 'alert'
  | 'coins'

const PATHS: Record<IconName, React.ReactNode> = {
  jar: (
    <>
      <rect x="7" y="2.5" width="10" height="3.5" rx="1" />
      <path d="M8 6v1.5C6.3 8.3 5.5 9.6 5.5 11.5V19a2.5 2.5 0 0 0 2.5 2.5h8a2.5 2.5 0 0 0 2.5-2.5v-7.5c0-1.9-.8-3.2-2.5-4V6" />
      <path d="M5.5 14.5c2.2-1.3 4.3-1.3 6.5 0s4.3 1.3 6.5 0" />
    </>
  ),
  sun: (
    <>
      <circle cx="12" cy="12" r="4" />
      <path d="M12 2v2.5M12 19.5V22M4.9 4.9l1.8 1.8M17.3 17.3l1.8 1.8M2 12h2.5M19.5 12H22M4.9 19.1l1.8-1.8M17.3 6.7l1.8-1.8" />
    </>
  ),
  chat: <path d="M20.5 11.5c0 4.1-3.8 7.5-8.5 7.5-1.2 0-2.3-.2-3.3-.6L3.5 20l1.4-4.1A7 7 0 0 1 3.5 11.5C3.5 7.4 7.3 4 12 4s8.5 3.4 8.5 7.5Z" />,
  sparkle: (
    <>
      <path d="M11 3.5 12.9 9l5.6 2-5.6 2L11 18.5 9.1 13l-5.6-2 5.6-2Z" />
      <path d="M19 2.5v4M17 4.5h4" />
    </>
  ),
  bolt: <path d="M13.5 2.5 4.5 13.5h7l-1 8 9-11h-7Z" />,
  star: <path d="m12 3 2.7 5.6 6.1.8-4.5 4.3 1.1 6.1L12 16.9l-5.4 2.9 1.1-6.1-4.5-4.3 6.1-.8Z" />,
  flame: <path d="M12 21.5c3.9 0 6.5-2.6 6.5-6.3 0-3.5-2.4-5.4-3.6-8.7-.3 2.2-1.4 3.3-2.6 3.8C12.6 7 11 4.3 8.6 2.5c.2 3.4-3.1 6.2-3.1 10.4 0 4.7 2.6 8.6 6.5 8.6Z" />,
  chart: <path d="M4 20.5h16M7 16.5v-5M12 16.5v-9M17 16.5v-12" />,
  check: <path d="m4.5 12.5 5 5 10-11" />,
  x: <path d="M6 6l12 12M18 6 6 18" />,
  bot: (
    <>
      <rect x="4" y="7.5" width="16" height="12" rx="3.5" />
      <path d="M12 3.5v4M9 13v1.5M15 13v1.5M2 13v2.5M22 13v2.5" />
    </>
  ),
  plus: <path d="M12 5v14M5 12h14" />,
  undo: <path d="M9 14 4 9l5-5M4 9h10.5a5.5 5.5 0 0 1 0 11H11" />,
  arrow: <path d="M4 12h15M13 6l6 6-6 6" />,
  alert: <path d="M12 8v5M12 16.5v.5M10.3 3.9 2.6 17.5A2 2 0 0 0 4.3 20.5h15.4a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z" />,
  coins: (
    <>
      <ellipse cx="9" cy="7" rx="6" ry="3" />
      <path d="M3 7v4c0 1.7 2.7 3 6 3s6-1.3 6-3V7M3 11v4c0 1.7 2.7 3 6 3 1 0 1.9-.1 2.7-.3" />
      <circle cx="17" cy="16" r="4.5" />
    </>
  ),
}

export function Icon({ name, className = 'h-5 w-5', strokeWidth = 2.25 }: { name: IconName; className?: string; strokeWidth?: number }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={strokeWidth} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden="true">
      {PATHS[name]}
    </svg>
  )
}
