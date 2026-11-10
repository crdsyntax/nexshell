import { useAppStore } from '@/store/useAppStore'
import {
  ACCENT_PALETTE_NAMES,
  getAccentColors,
  UI_FONT_OPTIONS,
} from '@/lib/themes'
import {
  CheckIcon,
  MinusIcon,
  MonitorIcon,
  MoonIcon,
  NewspaperIcon,
  NotebookIcon,
  PaletteIcon,
  PlusIcon,
  RulerIcon,
  SunIcon,
  TerminalIcon,
  XIcon,
} from '@/components/Icons'

interface SettingsModalProps {
  open: boolean
  onClose: () => void
}

export function SettingsModal({ open, onClose }: SettingsModalProps) {
  const theme = useAppStore((state) => state.theme)
  const setTheme = useAppStore((state) => state.setTheme)
  const accentPalette = useAppStore((state) => state.accentPalette)
  const setAccentPalette = useAppStore((state) => state.setAccentPalette)
  const uiFontFamily = useAppStore((state) => state.uiFontFamily)
  const setUiFontFamily = useAppStore((state) => state.setUiFontFamily)
  const uiFontSize = useAppStore((state) => state.uiFontSize)
  const setUiFontSize = useAppStore((state) => state.setUiFontSize)
  const borderRadius = useAppStore((state) => state.borderRadius)
  const setBorderRadius = useAppStore((state) => state.setBorderRadius)

  if (!open) return null

  const isDark = theme === 'dark' || theme === 'editorial' || theme === 'terminal'

  return (
    <div
      className="settings-modal-backdrop"
      onClick={(e) => {
        if (e.target === e.currentTarget) onClose()
      }}
    >
      <div className="settings-modal-card" role="dialog" aria-modal="true">
        <header className="settings-modal-header">
          <h2 className="settings-modal-title">
            <PaletteIcon size={18} />
            Appearance & Themes
          </h2>
          <button
            className="icon-button"
            onClick={onClose}
            aria-label="Close"
            title="Close"
          >
            <XIcon size={16} />
          </button>
        </header>

        <div className="settings-modal-body">
          {/* Theme Selector */}
          <section>
            <h3 className="settings-section-title">Theme</h3>
            <div className="settings-theme-row">
              <button
                type="button"
                className={`settings-theme-btn ${theme === 'dark' ? 'is-active' : ''}`}
                onClick={() => setTheme('dark')}
              >
                <MoonIcon size={14} />
                Dark
              </button>
              <button
                type="button"
                className={`settings-theme-btn ${theme === 'light' ? 'is-active' : ''}`}
                onClick={() => setTheme('light')}
              >
                <SunIcon size={14} />
                Light
              </button>
              <button
                type="button"
                className={`settings-theme-btn ${theme === 'paper' ? 'is-active' : ''}`}
                onClick={() => setTheme('paper')}
              >
                <NotebookIcon size={14} />
                Paper
              </button>
              <button
                type="button"
                className={`settings-theme-btn ${theme === 'editorial' ? 'is-active' : ''}`}
                onClick={() => setTheme('editorial')}
              >
                <NewspaperIcon size={14} />
                Editorial
              </button>
              <button
                type="button"
                className={`settings-theme-btn ${theme === 'terminal' ? 'is-active' : ''}`}
                onClick={() => setTheme('terminal')}
              >
                <TerminalIcon size={14} />
                Terminal
              </button>
            </div>

            {(theme === 'paper' || theme === 'editorial' || theme === 'terminal') && (
              <p className="settings-theme-desc">
                {theme === 'paper'
                  ? 'Brutalist paper look from the landing page: warm background, black hairlines, ink accents.'
                  : theme === 'editorial'
                    ? 'Editorial noir: serif type on warm charcoal, high contrast, no pastels.'
                    : 'Terminal dev-tool look from the landing: dark, monospace, green accent.'}{' '}
                The accent palette below works in every theme.
              </p>
            )}
          </section>

          {/* Accent Color */}
          <section>
            <h3 className="settings-section-title">
              <PaletteIcon size={15} />
              Accent Color
            </h3>
            <div className="settings-accent-row">
              {ACCENT_PALETTE_NAMES.map((name) => {
                const colors = getAccentColors(name, isDark)
                const isActive = accentPalette === name
                return (
                  <button
                    key={name}
                    type="button"
                    className={`settings-accent-btn ${isActive ? 'is-active' : ''}`}
                    onClick={() => setAccentPalette(name)}
                  >
                    <div
                      className="settings-accent-swatch"
                      style={{ backgroundColor: colors.accent }}
                    >
                      {isActive && <CheckIcon size={14} />}
                    </div>
                    <span className="settings-accent-label">{name}</span>
                  </button>
                )
              })}
            </div>
          </section>

          {/* UI Font */}
          <section>
            <h3 className="settings-section-title">
              <MonitorIcon size={15} />
              UI Font
            </h3>
            <div className="settings-font-chips">
              {UI_FONT_OPTIONS.map((opt) => {
                const active = uiFontFamily === opt.value
                return (
                  <button
                    key={opt.value}
                    type="button"
                    className={`settings-font-chip ${active ? 'is-active' : ''}`}
                    onClick={() => setUiFontFamily(opt.value)}
                    style={{ fontFamily: opt.value }}
                  >
                    {opt.label}
                  </button>
                )
              })}
              <button
                type="button"
                className={`settings-font-chip ${uiFontFamily.includes('Inter Tight') ? 'is-active' : ''}`}
                onClick={() =>
                  setUiFontFamily(
                    "'Inter Tight', -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
                  )
                }
              >
                Default
              </button>
            </div>

            <div style={{ marginTop: 8 }}>
              <label style={{ fontSize: '11px', color: 'var(--muted-2)', display: 'block', marginBottom: 4 }}>
                Custom font family
              </label>
              <input
                type="text"
                value={uiFontFamily}
                onChange={(e) => setUiFontFamily(e.target.value)}
                placeholder="e.g. 'Poppins', sans-serif"
                spellCheck={false}
                style={{ width: '100%' }}
              />
            </div>

            <div style={{ marginTop: 14 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11.5px', color: 'var(--muted)' }}>
                <span>Font Size</span>
                <strong>{uiFontSize}px</strong>
              </div>
              <div className="settings-slider-row">
                <button
                  type="button"
                  className="settings-slider-btn"
                  onClick={() => setUiFontSize(Math.max(10, uiFontSize - 1))}
                  disabled={uiFontSize <= 10}
                >
                  <MinusIcon size={13} />
                </button>
                <input
                  type="range"
                  min={10}
                  max={24}
                  step={1}
                  value={uiFontSize}
                  onChange={(e) => setUiFontSize(Number(e.target.value))}
                  className="settings-range-input"
                />
                <button
                  type="button"
                  className="settings-slider-btn"
                  onClick={() => setUiFontSize(Math.min(24, uiFontSize + 1))}
                  disabled={uiFontSize >= 24}
                >
                  <PlusIcon size={13} />
                </button>
              </div>
            </div>
          </section>

          {/* Border Radius */}
          <section>
            <h3 className="settings-section-title">
              <RulerIcon size={15} />
              Border Radius
            </h3>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11.5px', color: 'var(--muted)' }}>
              <span>Corner Radius</span>
              <strong>{borderRadius}px</strong>
            </div>
            <div className="settings-slider-row">
              <button
                type="button"
                className="settings-slider-btn"
                onClick={() => setBorderRadius(Math.max(0, borderRadius - 1))}
                disabled={borderRadius <= 0}
              >
                <MinusIcon size={13} />
              </button>
              <input
                type="range"
                min={0}
                max={16}
                step={1}
                value={borderRadius}
                onChange={(e) => setBorderRadius(Number(e.target.value))}
                className="settings-range-input"
              />
              <button
                type="button"
                className="settings-slider-btn"
                onClick={() => setBorderRadius(Math.min(16, borderRadius + 1))}
                disabled={borderRadius >= 16}
              >
                <PlusIcon size={13} />
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  )
}
