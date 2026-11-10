import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { attachTerminal, detachTerminal } from '@/lib/terminalBus'
import { terminalService } from '@/services/terminal.service'
import { useAppStore } from '@/store/useAppStore'
import { AlertIcon, FolderIcon, PlugIcon, RefreshIcon, TerminalIcon, XIcon } from '@/components/Icons'
import { FileTree } from '@/components/FileTree'
import { getTerminalTheme } from '@/lib/themes'
import type { WorkspaceTab } from '@/types'

interface TerminalViewProps {
  tab: WorkspaceTab
}

const OSC7_INIT = [
  'if [ -n "$ZSH_VERSION" ]; then',
  `chpwd(){ printf '\\033]7;file://%s%s\\033\\\\' "\${HOST:-localhost}" "$PWD"; };`,
  'precmd(){ chpwd; }; chpwd;',
  'else',
  `PROMPT_COMMAND='printf "\\033]7;file://%s%s\\033\\\\" "\${HOSTNAME:-localhost}" "$PWD"'"\${PROMPT_COMMAND:+;$PROMPT_COMMAND}";`,
  'fi; clear',
].join(' ') + '\n' 

export function TerminalView({ tab }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const sessionRef = useRef<string | undefined>(undefined)
  const reconnectRef = useRef<() => void>(() => {})
  const mountedRef = useRef(false)
  const [treeOpen, setTreeOpen] = useState(true)
  const [isReconnecting, setIsReconnecting] = useState(false)

  const profile = useAppStore((state) =>
    state.profiles.find((p) => p.id === tab.profileId)
  )
  const closeTab = useAppStore((state) => state.closeTab)
  const theme = useAppStore((state) => state.theme)

  useEffect(() => {
    if (tab.status !== 'connecting') {
      setIsReconnecting(false)
    }
  }, [tab.status])

  useEffect(() => {
    if (termRef.current) {
      termRef.current.options.theme = getTerminalTheme(theme)
    }
  }, [theme])

  const handleReconnect = () => {
    setIsReconnecting(true)
    reconnectRef.current()
  }

  useEffect(() => {
    if (mountedRef.current || !containerRef.current) return
    mountedRef.current = true

    const term = new Terminal({
      fontFamily:
        '"JetBrains Mono", "Fira Code", ui-monospace, SFMono-Regular, Menlo, monospace',
      fontSize: 13,
      lineHeight: 1.22,
      letterSpacing: 0,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 8_000,
      allowTransparency: true,
      theme: getTerminalTheme(theme),
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(containerRef.current)
    fit.fit()
    fitRef.current = fit
    termRef.current = term

    const store = () => useAppStore.getState()

    const osc7 = term.parser.registerOscHandler(7, (data) => {
      const url = data.replace(/^file:\/\//, '')
      const slash = url.indexOf('/')
      if (slash < 0) return true
      try {
        const path = decodeURIComponent(url.slice(slash))
        if (path.startsWith('/')) store().setTerminalCwd(tab.id, path)
      } catch (error) {
        console.debug('operation failed', error)
      }
      return true
    })

    const inputDisposable = term.onData((data) => {
      const sessionId = sessionRef.current
      if (!sessionId) return
      void terminalService.write(sessionId, data).catch(() => {
        store().setTabStatus(tab.id, 'error', 'terminal input channel closed')
      })
    })

    const resizeDisposable = term.onResize(({ cols, rows }) => {
      const sessionId = sessionRef.current
      if (!sessionId) return
      void terminalService.resize(sessionId, cols, rows)
    })

    let cancelled = false

    const connect = async () => {
      if (cancelled) return
      store().setTabStatus(tab.id, 'connecting')
      const cols = term.cols || 120
      const rows = term.rows || 32

      try {
        const info =
          tab.processPid !== undefined
            ? await terminalService.openProcess(tab.profileId, tab.processPid, cols, rows)
            : tab.directory
              ? await terminalService.openDirectory(
                  tab.profileId,
                  tab.directory,
                  cols,
                  rows,
                )
              : await terminalService.open(tab.profileId, cols, rows)
        if (cancelled) {
          void terminalService.close(info.sessionId)
          return
        }
        sessionRef.current = info.sessionId
        attachTerminal(info.sessionId, (bytes) => term.write(bytes))
        store().setTabSession(tab.id, info)
        void terminalService.write(info.sessionId, OSC7_INIT).catch(() => undefined)
        term.focus()
      } catch (error) {
        if (cancelled) return
        store().setTabStatus(tab.id, 'error', String(error))
      }
    }

    reconnectRef.current = () => {
      if (cancelled) return
      const previous = sessionRef.current
      if (previous) detachTerminal(previous)
      sessionRef.current = undefined
      term.reset()
      void connect()
    }

    const observer = new ResizeObserver(() => {
      window.requestAnimationFrame(() => {
        const element = containerRef.current
        if (!element || element.clientWidth < 60 || element.clientHeight < 40) return
        try {
          fit.fit()
        } catch (error) {
          console.debug('resize skipped', error)
        }
      })
    })
    observer.observe(containerRef.current)

    const onFocus = () => term.focus()
    containerRef.current.addEventListener('click', onFocus)

    void connect()

    return () => {
      cancelled = true
      containerRef.current?.removeEventListener('click', onFocus)
      observer.disconnect()
      inputDisposable.dispose()
      resizeDisposable.dispose()
      osc7.dispose()
      const sessionId = sessionRef.current
      if (sessionId) {
        detachTerminal(sessionId)
        void terminalService.close(sessionId)
      }
      term.dispose()
      termRef.current = null
      fitRef.current = null
    }
  }, [tab.id, tab.profileId, tab.processPid, tab.directory])

  useEffect(() => {
    if (tab.status !== 'closed' && tab.status !== 'error') return
    const term = termRef.current
    if (!term) return
    const label = tab.status === 'error' ? 'error' : 'disconnected'
    term.writeln(`\r\n\x1b[38;5;203m── ${label}: ${tab.error ?? 'session ended'} ──\x1b[0m`)
  }, [tab.status, tab.error])

  return (
    <div className="terminal-view">
      <div className="terminal-view__chrome">
        <div className="terminal-view__title">
          <TerminalIcon size={13} />
          <span>{tab.title}</span>
          <span className={`tab-status tab-status--${tab.status}`} />
        </div>
        <div className="terminal-view__hint">
          {tab.status === 'connecting'
            ? tab.error ?? 'opening PTY…'
            : tab.status === 'connected'
              ? 'xterm-256color · PTY'
              : tab.status}
          <button
            className={`tree-toggle ${treeOpen ? 'is-active' : ''}`}
            onClick={() => setTreeOpen((value) => !value)}
            title={treeOpen ? 'Ocultar árbol de archivos' : 'Mostrar árbol de archivos'}
          >
            <FolderIcon size={13} />
          </button>
        </div>
      </div>
      <div className="terminal-body">
        <div ref={containerRef} className="terminal-view__terminal" />
        {treeOpen && (
          <FileTree
            profileId={tab.profileId}
            tabId={tab.id}
            onClose={() => setTreeOpen(false)}
          />
        )}
      </div>
      {(tab.status === 'closed' || tab.status === 'error') && (
        <div className="terminal-overlay" role="dialog" aria-modal="true" aria-label="Sesión desconectada">
          <div className="terminal-overlay__card">
            <div className={`terminal-overlay__icon-badge is-${tab.status}`}>
              {tab.status === 'error' ? (
                <AlertIcon size={24} />
              ) : (
                <PlugIcon size={24} />
              )}
            </div>

            <div className="terminal-overlay__meta">
              <div className="terminal-overlay__badge-row">
                <span className={`terminal-overlay__pill is-${tab.status}`}>
                  <span className="terminal-overlay__pill-dot" />
                  {tab.status === 'error' ? 'Error de conexión' : 'Sesión cerrada'}
                </span>
                {profile?.host && (
                  <span className="terminal-overlay__host-pill mono">
                    {profile.host}
                  </span>
                )}
              </div>

              <h3 className="terminal-overlay__title">
                {tab.status === 'error' ? 'Conexión interrumpida' : 'Sesión SSH finalizada'}
              </h3>

              <div className="terminal-overlay__subtitle">
                {profile ? (
                  <span>
                    Servidor: <strong className="mono">{profile.username}@{profile.host}:{profile.port}</strong>
                  </span>
                ) : (
                  <span>Terminal: <strong>{tab.title}</strong></span>
                )}
              </div>
            </div>

            <div className="terminal-overlay__callout">
              <div className="terminal-overlay__callout-header">
                <span>Motivo / Estado</span>
              </div>
              <div className="terminal-overlay__callout-body mono">
                {tab.error || (tab.status === 'error'
                  ? 'Se produjo un error no controlado en el canal PTY.'
                  : 'El host remoto cerró la conexión SSH o finalizó el proceso del shell.')}
              </div>
            </div>

            <div className="terminal-overlay__actions">
              <button
                type="button"
                className="terminal-overlay__btn-secondary"
                onClick={() => closeTab(tab.id)}
                title="Cerrar esta pestaña de terminal"
              >
                <XIcon size={14} />
                <span>Cerrar pestaña</span>
              </button>
              <button
                type="button"
                className="terminal-overlay__btn-primary"
                onClick={handleReconnect}
                disabled={isReconnecting}
              >
                <RefreshIcon size={14} className={isReconnecting ? 'spin' : ''} />
                <span>{isReconnecting ? 'Reconectando…' : 'Reconectar'}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
