import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { attachTerminal, detachTerminal } from '@/lib/terminalBus'
import { terminalService } from '@/services/terminal.service'
import { useAppStore } from '@/store/useAppStore'
import { AlertIcon, FolderIcon, RefreshIcon, TerminalIcon } from '@/components/Icons'
import { FileTree } from '@/components/FileTree'
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

const THEME = {
  background: '#1e1f29',
  foreground: '#f8f8f2',
  cursor: '#bd93f9',
  cursorAccent: '#1e1f29',
  selectionBackground: '#44475a',
  selectionForeground: '#f8f8f2',
  black: '#21222c',
  red: '#ff5555',
  green: '#50fa7b',
  yellow: '#f1fa8c',
  blue: '#bd93f9',
  magenta: '#ff79c6',
  cyan: '#8be9fd',
  white: '#f8f8f2',
  brightBlack: '#6272a4',
  brightRed: '#ff6e6e',
  brightGreen: '#69ff94',
  brightYellow: '#ffffa5',
  brightBlue: '#d6acff',
  brightMagenta: '#ff92df',
  brightCyan: '#a4ffff',
  brightWhite: '#ffffff',
}

export function TerminalView({ tab }: TerminalViewProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const sessionRef = useRef<string | undefined>(undefined)
  const reconnectRef = useRef<() => void>(() => {})
  const mountedRef = useRef(false)
  const [treeOpen, setTreeOpen] = useState(true)

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
      theme: THEME,
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
        <div className="terminal-overlay">
          <div className="terminal-overlay__card">
            <AlertIcon size={20} />
            <strong>
              {tab.status === 'error' ? 'Terminal error' : 'Session closed'}
            </strong>
            <p>{tab.error ?? 'The remote shell is no longer available.'}</p>
            <button className="primary-button" onClick={() => reconnectRef.current()}>
              <RefreshIcon size={15} /> Reconnect
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
