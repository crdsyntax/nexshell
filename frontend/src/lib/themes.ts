export interface AccentTheme {
  accent: string
  accentHover: string
  accentMuted: string
}

export interface Palette {
  light: AccentTheme
  dark: AccentTheme
}

export type ThemeType = 'light' | 'dark' | 'paper' | 'editorial' | 'terminal'

export const themePalettes: Record<string, Palette> = {
  nexshell: {
    light: { accent: '#1570ef', accentHover: '#175cd3', accentMuted: 'color-mix(in srgb, #1570ef 15%, transparent)' },
    dark: { accent: '#1570ef', accentHover: '#175cd3', accentMuted: 'color-mix(in srgb, #1570ef 20%, transparent)' },
  },
  dracula: {
    light: { accent: '#1570ef', accentHover: '#175cd3', accentMuted: 'color-mix(in srgb, #1570ef 15%, transparent)' },
    dark: { accent: '#1570ef', accentHover: '#175cd3', accentMuted: 'color-mix(in srgb, #1570ef 20%, transparent)' },
  },
  cyan: {
    light: { accent: '#06b6d4', accentHover: '#0891b2', accentMuted: 'color-mix(in srgb, #06b6d4 15%, transparent)' },
    dark: { accent: '#22d3ee', accentHover: '#67e8f9', accentMuted: 'color-mix(in srgb, #22d3ee 15%, transparent)' },
  },
  violet: {
    light: { accent: '#8b5cf6', accentHover: '#7c3aed', accentMuted: 'color-mix(in srgb, #8b5cf6 15%, transparent)' },
    dark: { accent: '#a78bfa', accentHover: '#c4b5fd', accentMuted: 'color-mix(in srgb, #a78bfa 15%, transparent)' },
  },
  amber: {
    light: { accent: '#f59e0b', accentHover: '#d97706', accentMuted: 'color-mix(in srgb, #f59e0b 15%, transparent)' },
    dark: { accent: '#fbbf24', accentHover: '#fcd34d', accentMuted: 'color-mix(in srgb, #fbbf24 15%, transparent)' },
  },
  rose: {
    light: { accent: '#f43f5e', accentHover: '#e11d48', accentMuted: 'color-mix(in srgb, #f43f5e 15%, transparent)' },
    dark: { accent: '#fb7185', accentHover: '#fda4af', accentMuted: 'color-mix(in srgb, #fb7185 15%, transparent)' },
  },
  emerald: {
    light: { accent: '#10b981', accentHover: '#059669', accentMuted: 'color-mix(in srgb, #10b981 15%, transparent)' },
    dark: { accent: '#34d399', accentHover: '#6ee7b7', accentMuted: 'color-mix(in srgb, #34d399 15%, transparent)' },
  },
}

export type AccentPalette = keyof typeof themePalettes

export const ACCENT_PALETTE_NAMES: AccentPalette[] = Object.keys(themePalettes) as AccentPalette[]

export function getAccentColors(name: AccentPalette, isDark: boolean): AccentTheme {
  const p = themePalettes[name] ?? themePalettes.nexshell
  return isDark ? p.dark : p.light
}

export const UI_FONT_OPTIONS = [
  { label: 'Inter Tight', value: "'Inter Tight', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" },
  { label: 'Poppins', value: "'Poppins', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" },
  { label: 'Inter', value: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" },
  { label: 'Segoe UI', value: "'Segoe UI', -apple-system, BlinkMacSystemFont, Roboto, sans-serif" },
  { label: 'System UI', value: "system-ui, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif" },
]

export function getTerminalTheme(theme: ThemeType) {
  switch (theme) {
    case 'paper':
      return {
        background: '#f4f2ec',
        foreground: '#0a0a0a',
        cursor: '#0a0a0a',
        cursorAccent: '#f4f2ec',
        selectionBackground: '#eae5da',
        selectionForeground: '#0a0a0a',
        black: '#0a0a0a',
        red: '#d92d20',
        green: '#16b364',
        yellow: '#f79009',
        blue: '#0a0a0a',
        magenta: '#b8402f',
        cyan: '#5071d5',
        white: '#4f4b41',
        brightBlack: '#7c776c',
        brightRed: '#ef4444',
        brightGreen: '#12b76a',
        brightYellow: '#f59e0b',
        brightBlue: '#33302a',
        brightMagenta: '#d92d20',
        brightCyan: '#06aed4',
        brightWhite: '#0a0a0a',
      }
    case 'editorial':
      return {
        background: '#141210',
        foreground: '#f2ecdd',
        cursor: '#b8402f',
        cursorAccent: '#141210',
        selectionBackground: '#24201a',
        selectionForeground: '#f2ecdd',
        black: '#141210',
        red: '#b8402f',
        green: '#16b364',
        yellow: '#e08b28',
        blue: '#5071d5',
        magenta: '#b8402f',
        cyan: '#38bdf8',
        white: '#a2988a',
        brightBlack: '#756c60',
        brightRed: '#d92d20',
        brightGreen: '#22c55e',
        brightYellow: '#fbbf24',
        brightBlue: '#60a5fa',
        brightMagenta: '#f43f5e',
        brightCyan: '#22d3ee',
        brightWhite: '#f2ecdd',
      }
    case 'terminal':
      return {
        background: '#0a0a0f',
        foreground: '#e8e8ee',
        cursor: '#4ade80',
        cursorAccent: '#0a0a0f',
        selectionBackground: '#1f212b',
        selectionForeground: '#e8e8ee',
        black: '#0a0a0f',
        red: '#f87171',
        green: '#4ade80',
        yellow: '#fbbf24',
        blue: '#38bdf8',
        magenta: '#c084fc',
        cyan: '#22d3ee',
        white: '#8a8b96',
        brightBlack: '#565869',
        brightRed: '#ef4444',
        brightGreen: '#22c55e',
        brightYellow: '#f59e0b',
        brightBlue: '#60a5fa',
        brightMagenta: '#d946ef',
        brightCyan: '#06b6d4',
        brightWhite: '#e8e8ee',
      }
    case 'light':
      return {
        background: '#ffffff',
        foreground: '#111111',
        cursor: '#1570ef',
        cursorAccent: '#ffffff',
        selectionBackground: '#e0f2fe',
        selectionForeground: '#111111',
        black: '#111111',
        red: '#d92d20',
        green: '#16b364',
        yellow: '#d97706',
        blue: '#1570ef',
        magenta: '#7a5af8',
        cyan: '#0891b2',
        white: '#98a2b3',
        brightBlack: '#667085',
        brightRed: '#ef4444',
        brightGreen: '#12b76a',
        brightYellow: '#f59e0b',
        brightBlue: '#2e90fa',
        brightMagenta: '#9e77ed',
        brightCyan: '#06aed4',
        brightWhite: '#111111',
      }
    case 'dark':
    default:
      return {
        background: '#10121a',
        foreground: '#cbd5e1',
        cursor: '#1570ef',
        cursorAccent: '#10121a',
        selectionBackground: '#202637',
        selectionForeground: '#f8fafc',
        black: '#10121a',
        red: '#f04438',
        green: '#12b76a',
        yellow: '#f79009',
        blue: '#1570ef',
        magenta: '#a78bfa',
        cyan: '#22d3ee',
        white: '#94a3b8',
        brightBlack: '#64748b',
        brightRed: '#f97066',
        brightGreen: '#34d399',
        brightYellow: '#fbbf24',
        brightBlue: '#53b1fd',
        brightMagenta: '#c4b5fd',
        brightCyan: '#67e8f9',
        brightWhite: '#f8fafc',
      }
  }
}
