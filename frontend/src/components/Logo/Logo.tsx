import { useId } from 'react'

interface LogoProps {
  size?: number
  className?: string
}

export function Logo({ size = 34, className }: LogoProps) {
  const rawId = useId().replace(/[^a-zA-Z0-9_-]/g, '')
  const markId = `two-shell-mark-${rawId}`
  const glowId = `two-shell-glow-${rawId}`

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 64 64"
      className={className}
      role="img"
      aria-label="2Shell"
    >
      <defs>
        <linearGradient id={markId} x1="18" y1="12" x2="49" y2="53" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#f97316" />
          <stop offset="1" stopColor="#a3e635" />
        </linearGradient>
        <radialGradient id={glowId} cx="32" cy="24" r="30" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor="#f97316" stopOpacity="0.16" />
          <stop offset="1" stopColor="#f97316" stopOpacity="0" />
        </radialGradient>
      </defs>
      <rect x="2" y="2" width="60" height="60" rx="16" fill="#0a0c0f" />
      <rect
        x="2.75"
        y="2.75"
        width="58.5"
        height="58.5"
        rx="15.25"
        fill="none"
        stroke="#232936"
        strokeWidth="1.5"
      />
      <circle cx="32" cy="26" r="27" fill={`url(#${glowId})`} />
      <path
        d="M19 22c0-6.1 5-9.5 12-9.5 6.9 0 11.6 3.7 11.6 9.1 0 4.2-2.7 6.8-7.1 9.9L23 40h19.3"
        fill="none"
        stroke={`url(#${markId})`}
        strokeWidth="5.4"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <rect x="43.5" y="42" width="7" height="7" rx="1.8" fill="#a3e635" />
    </svg>
  )
}
