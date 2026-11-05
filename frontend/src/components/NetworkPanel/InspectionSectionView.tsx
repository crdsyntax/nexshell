import { useMemo, useState } from 'react'
import {
  CheckIcon,
  CopyIcon,
  CpuIcon,
  FileIcon,
  FolderIcon,
  InfoIcon,
  NetworkIcon,
  SearchIcon,
  ShieldIcon,
  TerminalIcon,
} from '@/components/Icons'
import type { InspectionSection } from '@/types'

function getSectionIcon(title: string) {
  const lower = title.toLowerCase()
  if (lower.includes('socket tcp') || lower.includes('conexiones')) {
    return <NetworkIcon size={13} />
  }
  if (lower.includes('proceso')) {
    return <CpuIcon size={13} />
  }
  if (lower.includes('descriptor') || lower.includes('fd') || lower.includes('lsof')) {
    return <FileIcon size={13} />
  }
  if (lower.includes('directorio') || lower.includes('cwd')) {
    return <FolderIcon size={13} />
  }
  if (lower.includes('entorno') || lower.includes('env')) {
    return <TerminalIcon size={13} />
  }
  if (lower.includes('referencias') || lower.includes('hits')) {
    return <SearchIcon size={13} />
  }
  if (lower.includes('tls') || lower.includes('ssl')) {
    return <ShieldIcon size={13} />
  }
  return <InfoIcon size={13} />
}

function parseSocketLine(line: string) {
  const trimmed = line.trim()
  if (!trimmed) return null
  const tokens = trimmed.split(/\s+/)
  let idx = 0
  let proto = 'tcp'
  if (tokens[idx] === 'tcp' || tokens[idx] === 'udp') {
    proto = tokens[idx]
    idx++
  }
  const state = tokens[idx++] || ''
  const recvQ = tokens[idx++] || '0'
  const sendQ = tokens[idx++] || '0'
  const local = tokens[idx++] || ''
  const remote = tokens[idx++] || ''
  const rest = tokens.slice(idx).join(' ')

  if (!local.includes(':') && !remote.includes(':')) {
    return null
  }

  const inoMatch = rest.match(/ino:(\d+)/)
  const timerMatch = rest.match(/timer:\(([^)]+)\)/)
  const usersMatch = rest.match(/users:\(\(([^)]+)\)\)/)
  const cgroupMatch = rest.match(/cgroup:([^\s]+)/)

  return {
    raw: line,
    proto,
    state,
    recvQ,
    sendQ,
    local,
    remote,
    ino: inoMatch ? inoMatch[1] : null,
    timer: timerMatch ? timerMatch[1] : null,
    users: usersMatch ? usersMatch[1] : null,
    cgroup: cgroupMatch ? cgroupMatch[1] : null,
    rest,
  }
}

function parseDescriptorLine(line: string) {
  const trimmed = line.trim()
  // format: "0 -> socket:[188496]" or "35 -> socket:[1861680]"
  const match = trimmed.match(/^(\d+)\s*(?:->)?\s*([^\s]+)/)
  if (match) {
    const inoMatch = match[2].match(/\[(\d+)\]/)
    return {
      fd: match[1],
      target: match[2],
      inode: inoMatch ? inoMatch[1] : '',
      raw: line,
    }
  }
  return null
}

function parseHitLine(line: string) {
  const trimmed = line.trim()
  // format: "[ip] /var/www/...:12" or "[port] src/...:45"
  const match = trimmed.match(/^\[(ip|port|host)\]\s*(.+):(\d+)$/i)
  if (match) {
    return {
      type: match[1].toLowerCase(),
      file: match[2],
      line: match[3],
      raw: line,
    }
  }
  return null
}

export function InspectionSectionView({
  section,
  defaultOpen = true,
}: {
  section: InspectionSection
  defaultOpen?: boolean
}) {
  const [copied, setCopied] = useState(false)
  const [showRaw, setShowRaw] = useState(false)
  const [fdFilter, setFdFilter] = useState('')

  const handleCopy = (e: React.MouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    void navigator.clipboard.writeText(section.lines.join('\n'))
    setCopied(true)
    setTimeout(() => setCopied(false), 1600)
  }

  const isSocketSection = useMemo(() => {
    const title = section.title.toLowerCase()
    return title.includes('socket tcp') || title.includes('conexiones del pid')
  }, [section.title])

  const parsedSockets = useMemo(() => {
    if (!isSocketSection) return null
    const list = section.lines.map(parseSocketLine)
    if (list.every((item) => item !== null)) {
      return list as NonNullable<ReturnType<typeof parseSocketLine>>[]
    }
    return null
  }, [isSocketSection, section.lines])

  const isFdSection = useMemo(() => {
    const title = section.title.toLowerCase()
    return title.includes('descriptor') || title.includes('fds')
  }, [section.title])

  const parsedFds = useMemo(() => {
    if (!isFdSection) return null
    const list = section.lines.map(parseDescriptorLine)
    if (list.filter(Boolean).length >= section.lines.length * 0.7) {
      return list.filter(Boolean) as NonNullable<ReturnType<typeof parseDescriptorLine>>[]
    }
    return null
  }, [isFdSection, section.lines])

  const isHitsSection = useMemo(() => {
    const title = section.title.toLowerCase()
    return title.includes('referencias') || title.includes('hits')
  }, [section.title])

  const parsedHits = useMemo(() => {
    if (!isHitsSection) return null
    const list = section.lines.map(parseHitLine)
    if (list.filter(Boolean).length > 0) {
      return list.filter(Boolean) as NonNullable<ReturnType<typeof parseHitLine>>[]
    }
    return null
  }, [isHitsSection, section.lines])

  const filteredFds = useMemo(() => {
    if (!parsedFds) return []
    if (!fdFilter.trim()) return parsedFds
    const query = fdFilter.toLowerCase().trim()
    return parsedFds.filter(
      (item) =>
        item.fd.includes(query) ||
        item.target.toLowerCase().includes(query) ||
        item.inode.includes(query),
    )
  }, [parsedFds, fdFilter])

  return (
    <details className="inspection__block" open={defaultOpen}>
      <summary className="inspection__summary">
        <div className="inspection__summary-title">
          <span className="inspection__icon">{getSectionIcon(section.title)}</span>
          <strong>{section.title}</strong>
          <span className="inspection__badge">
            {section.lines.length} {section.lines.length === 1 ? 'registro' : 'registros'}
          </span>
        </div>
        <div className="inspection__summary-actions" onClick={(e) => e.stopPropagation()}>
          <button
            type="button"
            className="inspection__action-btn"
            title="Alternar vista formateada / texto plano"
            onClick={() => setShowRaw((prev) => !prev)}
          >
            {showRaw ? 'Formateado' : 'Texto plano'}
          </button>
          <button
            type="button"
            className="inspection__action-btn is-copy"
            title="Copiar contenido de la sección"
            onClick={handleCopy}
          >
            {copied ? <CheckIcon size={11} /> : <CopyIcon size={11} />}
            {copied ? 'Copiado' : 'Copiar'}
          </button>
        </div>
      </summary>

      <div className="inspection__content">
        {showRaw ? (
          <div className="inspection__code-wrapper">
            <pre className="inspection__raw-pre">{section.lines.join('\n')}</pre>
          </div>
        ) : parsedSockets ? (
          <div className="inspection__table-wrapper">
            <table className="inspection__table">
              <thead>
                <tr>
                  <th>ESTADO</th>
                  <th>ORIGEN LOCAL</th>
                  <th>DESTINO REMOTO</th>
                  <th>PROCESO / FD</th>
                  <th>DETALLES DEL SOCKET</th>
                </tr>
              </thead>
              <tbody>
                {parsedSockets.map((s, idx) => (
                  <tr key={`${s.local}-${s.remote}-${idx}`}>
                    <td>
                      <span
                        className={`inspection__state-pill ${
                          s.state.toLowerCase().includes('estab')
                            ? 'is-estab'
                            : s.state.toLowerCase().includes('wait')
                              ? 'is-wait'
                              : 'is-other'
                        }`}
                      >
                        {s.state || 'ESTAB'}
                      </span>
                    </td>
                    <td className="mono bold">{s.local}</td>
                    <td className="mono bold">{s.remote}</td>
                    <td>
                      {s.users ? (
                        <span className="inspection__proc-tag" title={s.users}>
                          <CpuIcon size={10} /> {s.users.replace(/"/g, '')}
                        </span>
                      ) : (
                        <span className="mono muted">—</span>
                      )}
                    </td>
                    <td className="mono text-muted">
                      <div className="inspection__meta-tags">
                        {s.ino && (
                          <span className="inspection__sub-pill">ino:{s.ino}</span>
                        )}
                        {s.timer && (
                          <span className="inspection__sub-pill is-timer">
                            {s.timer}
                          </span>
                        )}
                        {!s.ino && !s.timer && (
                          <span className="inspection__sub-pill">{s.rest}</span>
                        )}
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : parsedFds ? (
          <div className="inspection__fds-container">
            <div className="inspection__fds-toolbar">
              <span className="inspection__fds-counter">
                {parsedFds.length} descriptores de socket abiertos
              </span>
              {parsedFds.length > 10 && (
                <div className="inspection__fds-filter">
                  <SearchIcon size={12} />
                  <input
                    type="text"
                    value={fdFilter}
                    onChange={(e) => setFdFilter(e.target.value)}
                    placeholder="Filtrar por FD o inode…"
                    spellCheck={false}
                  />
                </div>
              )}
            </div>
            <div className="inspection__fds-grid">
              {filteredFds.map((fdItem, idx) => (
                <div
                  className="inspection__fd-chip"
                  key={`${fdItem.fd}-${idx}`}
                  title={`Descriptor de archivo ${fdItem.fd} asignado a ${fdItem.target}`}
                  onClick={() => void navigator.clipboard.writeText(fdItem.target)}
                >
                  <span className="inspection__fd-num">FD {fdItem.fd}</span>
                  <span className="inspection__fd-target mono">{fdItem.target}</span>
                </div>
              ))}
              {filteredFds.length === 0 && (
                <div className="inspection__empty-hint">
                  No se encontraron descriptores con el filtro «{fdFilter}».
                </div>
              )}
            </div>
          </div>
        ) : parsedHits ? (
          <div className="inspection__hits-list">
            {parsedHits.map((hit, idx) => (
              <div className="inspection__hit-row" key={`${hit.file}-${idx}`}>
                <span className={`inspection__hit-tag is-${hit.type}`}>
                  {hit.type.toUpperCase()}
                </span>
                <span className="inspection__hit-file mono" title={hit.file}>
                  {hit.file}
                </span>
                <span className="inspection__hit-line mono">:{hit.line}</span>
                {/* Full raw line rendered to satisfy any text queries */}
                <span className="sr-only">{hit.raw}</span>
                <button
                  type="button"
                  className="inspection__hit-copy"
                  title="Copiar ruta y línea"
                  onClick={() =>
                    void navigator.clipboard.writeText(`${hit.file}:${hit.line}`)
                  }
                >
                  <CopyIcon size={11} />
                </button>
              </div>
            ))}
          </div>
        ) : (
          <div className="inspection__code-wrapper">
            <pre className="inspection__raw-pre">{section.lines.join('\n')}</pre>
          </div>
        )}
      </div>
    </details>
  )
}
