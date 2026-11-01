import { useId } from 'react'

// A chunky jar whose liquid level shows how full a bill jar is.
// Server- and client-safe (no state); the wave is pure CSS animation.

const FILLS = {
  mandarin: { liquid: '#ff6b00', crest: '#ff8a33' },
  crest: { liquid: '#ffc72c', crest: '#ffd965' },
  forest: { liquid: '#1d5a3f', crest: '#2f7a57' },
} as const

export type JarColor = keyof typeof FILLS
export type JarIcon = 'bolt' | 'signal' | 'phone' | 'spark'

// 24x24 icons drawn in the jar label.
function LabelIcon({ icon }: { icon: JarIcon }) {
  if (icon === 'bolt') return <path d="M13.5 1.5 4 13.5h7l-1.5 9L19 10.5h-7z" fill="#ff6b00" stroke="#0b1f16" strokeWidth="2.4" strokeLinejoin="round" />
  if (icon === 'spark')
    return (
      <g stroke="#0b1f16" strokeWidth="2.2" strokeLinejoin="round">
        <path d="M10 2.5 12.2 9l6.3 2.2-6.3 2.3L10 20l-2.2-6.5L1.5 11.2 7.8 9z" fill="#ff6b00" />
        <path d="M19 1.5l1 2.6 2.5 1-2.5 1-1 2.6-1-2.6-2.5-1 2.5-1z" fill="#ffc72c" strokeWidth="1.6" />
      </g>
    )
  if (icon === 'signal')
    return (
      <g fill="#0b1f16">
        <rect x="2" y="15" width="5" height="7" rx="1.5" />
        <rect x="9.5" y="9.5" width="5" height="12.5" rx="1.5" />
        <rect x="17" y="3" width="5" height="19" rx="1.5" fill="#ff6b00" stroke="#0b1f16" strokeWidth="2" />
      </g>
    )
  return (
    <path
      d="M6 2.5h3.5l2 5-2.6 1.7a11.5 11.5 0 0 0 5.9 5.9l1.7-2.6 5 2V18a3 3 0 0 1-3 3C10 21 3 14 3 5.5a3 3 0 0 1 3-3z"
      fill="#ffc72c"
      stroke="#0b1f16"
      strokeWidth="2.4"
      strokeLinejoin="round"
    />
  )
}

export function Jar({
  pct,
  color = 'mandarin',
  className = '',
  lid = '#ffc72c',
  label,
  children,
}: {
  pct: number
  color?: JarColor
  className?: string
  lid?: string
  /** A sticker on the jar: icon + word, e.g. { icon: 'bolt', text: 'Light' } */
  label?: { icon: JarIcon; text: string }
  children?: React.ReactNode
}) {
  const id = useId().replace(/:/g, '')
  const level = Math.max(0, Math.min(100, pct))
  // Inner jar body spans y=44..196 (152px). Liquid top moves with level.
  const top = 196 - (152 * level) / 100
  const { liquid, crest } = FILLS[color]
  const wave = (y: number) =>
    `M0 ${y} Q 25 ${y - 7} 50 ${y} T 100 ${y} T 150 ${y} T 200 ${y} T 250 ${y} T 300 ${y} T 350 ${y} T 400 ${y} V 210 H 0 Z`

  return (
    <div className={`relative ${className}`}>
      <svg viewBox="0 0 160 210" className="h-full w-full overflow-visible" role="img" aria-label={`${level}% full`}>
        <defs>
          <clipPath id={`body-${id}`}>
            <path d="M22 52c0-8 6-14 14-14h88c8 0 14 6 14 14v128c0 10-8 18-18 18H40c-10 0-18-8-18-18z" />
          </clipPath>
        </defs>
        {/* shadow */}
        <path d="M28 58c0-8 6-14 14-14h88c8 0 14 6 14 14v128c0 10-8 18-18 18H46c-10 0-18-8-18-18z" fill="#0b1f16" />
        {/* body */}
        <path d="M22 52c0-8 6-14 14-14h88c8 0 14 6 14 14v128c0 10-8 18-18 18H40c-10 0-18-8-18-18z" fill="#fff6e5" />
        <g clipPath={`url(#body-${id})`}>
          {level > 0 && (
            <>
              <g style={{ transform: `translateY(${top - 6}px)`, transition: 'transform 900ms cubic-bezier(.34,1.3,.64,1)' }}>
                <path d={wave(6)} fill={crest} className="animate-wave-slow" />
              </g>
              <g style={{ transform: `translateY(${top}px)`, transition: 'transform 900ms cubic-bezier(.34,1.3,.64,1)' }}>
                <path d={wave(6)} fill={liquid} className="animate-wave" />
              </g>
            </>
          )}
          {/* shine */}
          <rect x="34" y="56" width="10" height="90" rx="5" fill="#ffffff" opacity="0.55" />
        </g>
        <path
          d="M22 52c0-8 6-14 14-14h88c8 0 14 6 14 14v128c0 10-8 18-18 18H40c-10 0-18-8-18-18z"
          fill="none"
          stroke="#0b1f16"
          strokeWidth="5"
        />
        {label && (
          <g>
            <rect x="36" y="84" width="88" height="60" rx="12" fill="#0b1f16" transform="translate(3 3)" />
            <rect x="36" y="84" width="88" height="60" rx="12" fill="#fff6e5" stroke="#0b1f16" strokeWidth="4" />
            <g transform="translate(68 92)">
              <LabelIcon icon={label.icon} />
            </g>
            <text
              x="80"
              y="134"
              textAnchor="middle"
              fontSize="13"
              fontWeight="800"
              letterSpacing="1.2"
              fill="#0b1f16"
              style={{ fontFamily: 'var(--font-bricolage), sans-serif', textTransform: 'uppercase' }}
            >
              {label.text.toUpperCase()}
            </text>
          </g>
        )}
        {/* lid */}
        <rect x="40" y="12" width="80" height="26" rx="8" fill="#0b1f16" transform="translate(4 4)" />
        <rect x="40" y="12" width="80" height="26" rx="8" fill={lid} stroke="#0b1f16" strokeWidth="5" />
        <line x1="54" y1="25" x2="106" y2="25" stroke="#0b1f16" strokeWidth="4" strokeLinecap="round" opacity="0.35" />
      </svg>
      {children && <div className="absolute inset-x-0 top-[34%] flex flex-col items-center text-center">{children}</div>}
    </div>
  )
}
