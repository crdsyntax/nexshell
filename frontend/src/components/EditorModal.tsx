import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { attachTerminal, detachTerminal } from '@/lib/terminalBus'
import { terminalService } from '@/services/terminal.service'
import { fsService } from '@/services/fs.service'
import { AlertIcon, XIcon } from '@/components/Icons'

interface EditorModalProps {
  profileId: string
  path: string
  onClose: () => void
}

const THEME = {
  background: '#0a0c0f',
  foreground: '#e4e5e8',
  cursor: '#fbbf24',
  cursorAccent: '#0a0c0f',
  selectionBackground: '#343c4d',
  black: '#15181f',
  red: '#ef4444',
  green: '#a3e635',
  yellow: '#fbbf24',
  blue: '#60a5fa',
  magenta: '#c084fc',
  cyan: '#5eead4',
  white: '#e4e5e8',
  brightBlack: '#5a6272',
  brightRed: '#fca5a5',
  brightGreen: '#a3e635',
  brightYellow: '#fde68a',
  brightBlue: '#a3e635',
  brightMagenta: '#d8b4fe',
  brightCyan: '#99f6e4',
  brightWhite: '#f8fafc',
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`
}

function parentOf(path: string): string {
  const index = path.lastIndexOf('/')
  return index <= 0 ? '/' : path.slice(0, index)
}

export function EditorModal({ profileId, path, onClose }: EditorModalProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const sessionRef = useRef<string | undefined>(undefined)
  const termRef = useRef<Terminal | null>(null)
  const [editor, setEditor] = useState('')
  const [status, setStatus] = useState('abriendo editor…')
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    let disposed = false

    const term = new Terminal({
      fontFamily: 'JetBrains Mono, ui-monospace, monospace',
      fontSize: 12,
      lineHeight: 1.25,
      cursorBlink: true,
      scrollback: 4000,
      theme: THEME,
    })
    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(container)
    fit.fit()
    termRef.current = term

    const input = term.onData((data) => {
      if (sessionRef.current) void terminalService.write(sessionRef.current, data)
    })
    const resize = term.onResize(({ cols, rows }) => {
      if (sessionRef.current) void terminalService.resize(sessionRef.current, cols, rows)
    })

    const connect = async () => {
      try {
        const name = await fsService.editor(profileId)
        if (disposed) return
        setEditor(name)
        const info = await terminalService.openDirectory(
          profileId,
          parentOf(path),
          term.cols || 100,
          term.rows || 30,
        )
        if (disposed) {
          void terminalService.close(info.sessionId)
          return
        }
        sessionRef.current = info.sessionId
        attachTerminal(info.sessionId, (bytes) => term.write(bytes))
        await terminalService.write(
          info.sessionId,
          `${name} -- ${shellQuote(path)}\n`,
        )
        setStatus(`editando con ${name}`)
        term.focus()
      } catch (err) {
        if (!disposed) {
          setError(String(err))
          setStatus('error')
        }
      }
    }

    void connect()

    const observer = new ResizeObserver(() => {
      window.requestAnimationFrame(() => {
        try {
          fit.fit()
        } catch {
          // container hidden during layout
        }
      })
    })
    observer.observe(container)

    return () => {
      disposed = true
      observer.disconnect()
      input.dispose()
      resize.dispose()
      const sessionId = sessionRef.current
      if (sessionId) {
        detachTerminal(sessionId)
        void terminalService.close(sessionId)
      }
      term.dispose()
      termRef.current = null
    }
  }, [profileId, path])

  const close = () => {
    if (
      window.confirm(
        '¿Cerrar el editor? Los cambios sin guardar se perderán. Guarda antes con :wq (vim) o Ctrl+O / Ctrl+X (nano).',
      )
    ) {
      onClose()
    }
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) close()
      }}
    >
      <div className="modal modal--editor" role="dialog" aria-modal="true">
        <header className="modal__header">
          <div>
            <h2>
              Editar
              <span className="panel__sub">{path}</span>
            </h2>
            <p>
              {status}
              {editor ? ` · ${editor}` : ''}
            </p>
          </div>
          <button className="icon-button" onClick={close} title="Cerrar">
            <XIcon size={16} />
          </button>
        </header>
        <div className="modal__body editor-body">
          {error && (
            <div className="inline-alert inline-alert--error">
              <AlertIcon size={15} />
              <span>{error}</span>
            </div>
          )}
          <div ref={containerRef} className="editor-terminal" />
        </div>
        <footer className="modal__footer">
          <span className="field-hint">
            El editor corre en el VPS. Cerrar este panel termina la sesión.
          </span>
          <button className="ghost-button" onClick={close}>
            Cerrar
          </button>
        </footer>
      </div>
    </div>
  )
}
