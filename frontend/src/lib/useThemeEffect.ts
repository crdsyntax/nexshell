import { useEffect } from 'react'
import { useAppStore } from '@/store/useAppStore'
import { getAccentColors } from '@/lib/themes'

export function useThemeEffect() {
  const theme = useAppStore((state) => state.theme)
  const accentPalette = useAppStore((state) => state.accentPalette)
  const uiFontFamily = useAppStore((state) => state.uiFontFamily)
  const uiFontSize = useAppStore((state) => state.uiFontSize)
  const borderRadius = useAppStore((state) => state.borderRadius)

  useEffect(() => {
    const root = document.documentElement
    const isDark = theme === 'dark' || theme === 'editorial' || theme === 'terminal'
    const classNames: string[] = [theme]
    if (isDark) {
      classNames.push('dark', 'theme-dark')
    } else {
      classNames.push('light', 'theme-light')
    }
    classNames.push(`theme-${theme}`)

    root.className = classNames.join(' ')
    root.setAttribute('data-theme', isDark ? 'dark' : 'light')
    if (document.body) {
      document.body.className = `theme-${theme} ${isDark ? 'theme-dark' : 'theme-light'}`
    }

    const accent = getAccentColors(accentPalette, isDark)
    root.style.setProperty('--accent', accent.accent)
    root.style.setProperty('--accent-hover', accent.accentHover)
    root.style.setProperty('--accent-muted', accent.accentMuted)

    const fontToApply = (!uiFontFamily || uiFontFamily.includes("Inter, 'Segoe UI'"))
      ? "'Inter Tight', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif"
      : uiFontFamily
    root.style.setProperty('--font-body', fontToApply)
    root.style.setProperty('--font-display', fontToApply)
    root.style.setProperty('--sans', fontToApply)

    root.style.setProperty('--ch-ui-font-size', `${uiFontSize}px`)
    root.style.setProperty('--radius', `${borderRadius}px`)
    root.style.setProperty('--radius-sm', `${Math.max(4, borderRadius - 2)}px`)
    root.style.setProperty('--radius-xs', `${Math.max(3, borderRadius - 4)}px`)
    root.style.setProperty('--radius-lg', `${borderRadius + 2}px`)
  }, [theme, accentPalette, uiFontFamily, uiFontSize, borderRadius])
}
