import { CopyIcon } from '@/components/Icons'
import { useLogViewer } from './useLogViewer'

interface LogViewerProps {
  text: string
  empty?: string
}

export function LogViewer({ text, empty = '(empty)' }: LogViewerProps) {
  const {
    lines,
    issues,
    shown,
    errorCount,
    warnCount,
    onlyIssues,
    setOnlyIssues,
    copy,
    copyIssues,
    copyAll,
  } = useLogViewer(text)

  if (lines.length === 0) {
    return <div className="log-viewer log-viewer--empty">{empty}</div>
  }

  return (
    <div className="log-viewer">
      <div className="log-viewer__bar">
        <span className="log-viewer__stats">
          {lines.length} líneas · <b className="is-error">{errorCount} errores</b> ·{' '}
          <b className="is-warn">{warnCount} avisos</b>
        </span>
        <button
          className={onlyIssues ? 'is-active' : ''}
          onClick={() => setOnlyIssues((value) => !value)}
        >
          solo errores
        </button>
        <button
          onClick={() => void copyIssues()}
          disabled={issues.length === 0}
          title="Copiar solo las líneas de error y su stack"
        >
          <CopyIcon size={12} /> copiar errores
        </button>
        <button onClick={() => void copyAll()} title="Copiar todo el log">
          <CopyIcon size={12} /> copiar todo
        </button>
      </div>
      <div className="log-viewer__body">
        {shown.map((line) => (
          <div
            key={line.index}
            className={`log-line is-${line.kind}`}
            onClick={() => void copy(line.text, 'Línea copiada')}
            title="Clic para copiar esta línea"
          >
            <span className="log-line__no">{line.index + 1}</span>
            <span className="log-line__text">{line.text || ' '}</span>
            <span className="log-line__copy">
              <CopyIcon size={12} />
            </span>
          </div>
        ))}
        {shown.length === 0 && <div className="log-viewer--empty">sin líneas de error</div>}
      </div>
    </div>
  )
}
