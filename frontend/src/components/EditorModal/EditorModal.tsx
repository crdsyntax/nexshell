import { useEffect, useRef, useState } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import '@xterm/xterm/css/xterm.css'
import { attachTerminal, detachTerminal } from '@/lib/terminalBus'
import { terminalService } from '@/services/terminal.service'
import { fsService } from '@/services/fs.service'
import { AlertIcon, XIcon } from '@/components/Icons'
import { useResizable } from '@/lib/useResizable'

interface EditorModalProps {
  profileId: string
  path: string
  onClose: () => void
}

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
  const editorResize = useResizable({
    initial: { width: 1120, height: 700 },
    min: { width: 600, height: 360 },
    storageKey: '2shell.modal.editor.size',
  })
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
        } catch (error) {
          console.debug('resize skipped', error)
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
      <div
        className="modal modal--editor modal--resizable"
        role="dialog"
        aria-modal="true"
        style={editorResize.style}
      >
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
        <span
          className="modal-resize"
          onPointerDown={editorResize.start}
          title="Arrastrar para redimensionar"
        />
      </div>
    </div>
  )
}
