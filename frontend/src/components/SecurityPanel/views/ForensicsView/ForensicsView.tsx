import {
  AlertIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronUpIcon,
  ClockIcon,
  FolderIcon,
  KeyIcon,
  RefreshIcon,
  SearchIcon,
  ShieldIcon,
  ShieldOffIcon,
  TerminalIcon,
  XIcon,
} from '@/components/Icons'
import { useMemo, useState } from 'react'

import { useForensicsView } from './useForensicsView'

type AuthSortField = 'timestamp' | 'user' | 'from' | 'method' | 'status'
type SortDirection = 'asc' | 'desc'
type StatusFilter = 'all' | 'failed' | 'success' | 'blocked'

const MONTH_MAP: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
}

function parseAuthTimestamp(ts: string): number {
  if (!ts) return 0
  const iso = Date.parse(ts)
  if (!isNaN(iso)) return iso
  const parts = ts.trim().split(/\s+/)
  if (parts.length >= 3) {
    const month = MONTH_MAP[parts[0].toLowerCase().slice(0, 3)]
    const day = parseInt(parts[1], 10)
    const timeParts = parts[2].split(':').map((x) => parseInt(x, 10))
    if (month !== undefined && !isNaN(day) && timeParts.length >= 3) {
      const year = new Date().getFullYear()
      return new Date(
        year,
        month,
        day,
        timeParts[0] || 0,
        timeParts[1] || 0,
        timeParts[2] || 0,
      ).getTime()
    }
  }
  return 0
}

function parseLastDate(raw: string): { date: string; time: string } | null {
  if (!raw || raw === '—' || raw.toLowerCase().includes('logged in')) return null
  const parts = raw.trim().split(/\s+/)
  if (parts.length >= 5) {
    const [, month, day, time, year] = parts
    return {
      date: `${year || ''} ${month} ${day}`.trim(),
      time,
    }
  }
  return null
}

export function ForensicsView({ profileId }: { profileId: string }) {
  const {
    aiTools,
    artifacts,
    attempts,
    authFailed,
    authIps,
    authOk,
    blockIp,
    blockedIps,
    blocking,
    error,
    filter,
    filteredSessions,
    hits,
    loading,
    path,
    query,
    regex,
    run,
    secrets,
    section,
    sessions,
    setFilter,
    setPath,
    setQuery,
    setRegex,
    setSection,
    unblockIp,
    uniqueIps,
    chainVerification,
    verifyingChain,
    verifyChain,
    exportingManifest,
    exportManifest,
  } = useForensicsView(profileId)

  const [authSortField, setAuthSortField] = useState<AuthSortField>('timestamp')
  const [authSortDir, setAuthSortDir] = useState<SortDirection>('desc')
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('all')

  const toggleAuthSort = (field: AuthSortField) => {
    if (authSortField === field) {
      setAuthSortDir((dir) => (dir === 'asc' ? 'desc' : 'asc'))
    } else {
      setAuthSortField(field)
      setAuthSortDir(field === 'timestamp' ? 'desc' : 'asc')
    }
  }

  const activeSessionsCount = useMemo(
    () => sessions.filter((s) => s.current || s.end?.toLowerCase().includes('logged in')).length,
    [sessions],
  )
  const failedCount = useMemo(
    () => attempts.filter((item) => item.status === 'failed').length,
    [attempts],
  )
  const successCount = useMemo(
    () => attempts.filter((item) => item.status === 'success').length,
    [attempts],
  )
  const blockedAttemptsCount = useMemo(
    () => attempts.filter((item) => item.from && blockedIps.includes(item.from)).length,
    [attempts, blockedIps],
  )

  const processedAttempts = useMemo(() => {
    const term = filter.trim().toLowerCase()
    const filtered = attempts.filter((item) => {
      if (statusFilter === 'failed' && item.status !== 'failed') return false
      if (statusFilter === 'success' && item.status !== 'success') return false
      if (statusFilter === 'blocked' && (!item.from || !blockedIps.includes(item.from))) return false

      if (term) {
        const matches = [item.user, item.from, item.status, item.method, item.detail]
          .filter(Boolean)
          .join(' ')
          .toLowerCase()
          .includes(term)
        if (!matches) return false
      }
      return true
    })

    return filtered.sort((a, b) => {
      let cmp = 0
      if (authSortField === 'timestamp') {
        const tA = parseAuthTimestamp(a.timestamp)
        const tB = parseAuthTimestamp(b.timestamp)
        cmp = tA === tB ? a.timestamp.localeCompare(b.timestamp) : tA - tB
      } else if (authSortField === 'user') {
        cmp = (a.user || '').localeCompare(b.user || '')
      } else if (authSortField === 'from') {
        cmp = (a.from || '').localeCompare(b.from || '')
      } else if (authSortField === 'method') {
        cmp = (a.method || '').localeCompare(b.method || '')
      } else if (authSortField === 'status') {
        cmp = (a.status || '').localeCompare(b.status || '')
      }
      return authSortDir === 'asc' ? cmp : -cmp
    })
  }, [attempts, filter, statusFilter, blockedIps, authSortField, authSortDir])

  return (
    <div className="security-view">
      <div className="sec-toolbar">
        <div className="security-tabs">
          {(
            [
              ['sessions', 'Sesiones SSH', TerminalIcon],
              ['auth', 'Intentos SSH', ShieldIcon],
              ['artifacts', 'Artefactos', FolderIcon],
              ['search', 'Búsqueda', SearchIcon],
              ['secrets', 'Secretos', KeyIcon],
            ] as const
          ).map(([value, label, Icon]) => (
            <button
              key={value}
              className={section === value ? 'is-active' : ''}
              onClick={() => setSection(value)}
            >
              <Icon size={13} />
              {label}
              {loading[value] && <RefreshIcon size={11} className="spin" />}
            </button>
          ))}
        </div>
        <div className="forensics-stats">
          {section === 'sessions' && (
            <>
              {activeSessionsCount > 0 && (
                <span className="forensics-stat-pill is-ok">
                  <span className="forensics-live-dot" /> <strong>{activeSessionsCount}</strong> activa{activeSessionsCount > 1 ? 's' : ''}
                </span>
              )}
              <span className="forensics-stat-pill">
                <strong>{sessions.length}</strong> sesiones
              </span>
              <span className="forensics-stat-pill">
                <strong>{uniqueIps.length}</strong> IPs únicas
              </span>
            </>
          )}
          {section === 'auth' && (
            <>
              <span className="forensics-stat-pill">
                <strong>{attempts.length}</strong> intentos ({authIps.length} IPs)
              </span>
              <span className="forensics-stat-pill is-error">
                <strong>{authFailed}</strong> fallidos
              </span>
              <span className="forensics-stat-pill is-ok">
                <strong>{authOk}</strong> correctos
              </span>
            </>
          )}
          {section === 'artifacts' && (
            <span className="forensics-stat-pill">
              <strong>{artifacts.length}</strong> entradas
            </span>
          )}
          {section === 'search' && (
            <span className="forensics-stat-pill">
              <strong>{hits.length}</strong> coincidencias
            </span>
          )}
          {section === 'secrets' && (
            <span className="forensics-stat-pill is-warn">
              <strong>{secrets.length}</strong> archivos expuestos
            </span>
          )}
        </div>
        <div style={{ display: 'flex', gap: 6, alignItems: 'center', marginLeft: 'auto' }}>
          {chainVerification && (
            <span
              className={`sec-status ${chainVerification.valid ? 'is-ok' : 'is-bad'}`}
              title={
                chainVerification.valid
                  ? `Chain of custody verified: ${chainVerification.verifiedRecords} signed records. Head: ${chainVerification.latestHash.slice(0, 16)}…`
                  : `Chain integrity violation at #${chainVerification.brokenAtId}: ${chainVerification.failureReason || 'hash mismatch'}`
              }
            >
              {chainVerification.valid ? <CheckIcon size={12} /> : <AlertIcon size={12} />}
              {chainVerification.valid ? 'Chain: Valid' : 'Chain: Tampered'}
            </span>
          )}
          <button
            type="button"
            className="ghost-button ghost-button--xs"
            onClick={() => void verifyChain()}
            disabled={verifyingChain}
            title="Verify cryptographic hash chain and HMAC signatures across all execution logs"
          >
            <ShieldIcon size={12} className={verifyingChain ? 'spin' : ''} />
            {verifyingChain ? 'Verifying…' : 'Verify Chain'}
          </button>
          <button
            type="button"
            className="ghost-button ghost-button--xs"
            onClick={() => void exportManifest()}
            disabled={exportingManifest}
            title="Generate cryptographically signed forensic manifest and copy JSON to clipboard"
          >
            <KeyIcon size={12} />
            {exportingManifest ? 'Signing…' : 'Sign Manifest'}
          </button>
        </div>
      </div>
      {error && (
        <div className="inline-alert inline-alert--error">
          <AlertIcon size={15} />
          <span>{error}</span>
        </div>
      )}
      {['artifacts', 'search', 'secrets'].includes(section) && (
        <div className="forensics-toolbar">
          <label className="forensics-field">
            <span>ruta</span>
            <input value={path} onChange={(event) => setPath(event.target.value)} spellCheck={false} />
          </label>
          {section === 'search' && (
            <>
              <label className="forensics-field forensics-field--grow">
                <span>texto</span>
                <input
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') void run('search')
                  }}
                  placeholder="useradd, curl, base64…"
                  spellCheck={false}
                />
              </label>
              <label className="forensics-check">
                <input
                  type="checkbox"
                  checked={regex}
                  onChange={(event) => setRegex(event.target.checked)}
                />
                regex
              </label>
            </>
          )}
          <button
            className="primary-button forensics-scan-btn"
            onClick={() => void run(section)}
            disabled={loading[section]}
          >
            {section === 'search' ? (
              <SearchIcon size={13} />
            ) : (
              <RefreshIcon size={13} className={loading[section] ? 'spin' : ''} />
            )}
            {loading[section] ? 'Ejecutando…' : section === 'search' ? 'Buscar' : 'Escanear'}
          </button>
        </div>
      )}
      {section === 'sessions' && (
        <>
          <div className="forensics-toolbar">
            <div className="db-search forensics-filter">
              <SearchIcon size={13} />
              <input
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Filtrar por usuario, IP o tty…"
                spellCheck={false}
              />
            </div>
            <button
              className="primary-button"
              onClick={() => void run('sessions')}
              disabled={loading.sessions}
            >
              <RefreshIcon size={13} className={loading.sessions ? 'spin' : ''} />
              {loading.sessions ? 'Leyendo…' : 'Actualizar'}
            </button>
          </div>
          <div className="network-block">
            <header>
              <h3>
                <ClockIcon size={13} /> Historial y sesiones activas (last / who)
              </h3>
              <span>{filteredSessions.length} filas</span>
            </header>
            <div className="forensics-table forensics-table--sessions">
              <div className="forensics-row forensics-row--head">
                <span>USUARIO</span>
                <span>TTY</span>
                <span>ORIGEN</span>
                <span>INICIO</span>
                <span>FIN</span>
                <span>DURACIÓN</span>
                <span>ESTADO</span>
                <span>ACCIONES</span>
              </div>
              {filteredSessions.map((session, index) => {
                const parsedStart = parseLastDate(session.start)
                const isLive = session.current || session.end?.toLowerCase().includes('logged in')
                const parsedEnd = parseLastDate(session.end)
                const isSelf = Boolean(session.isCurrent)

                return (
                  <div
                    className={`forensics-row ${isSelf ? 'is-current-session' : ''}`}
                    key={`${session.user}-${session.tty}-${session.start}-${index}`}
                  >
                    <span className={`mono forensics-user ${session.user === 'root' ? 'is-root' : ''}`}>
                      {session.user}
                      {isSelf && (
                        <span className="forensics-self-pill" title="Sesión activa correspondiente a esta conexión">
                          actual
                        </span>
                      )}
                    </span>
                    <span className="mono forensics-tty">{session.tty}</span>
                    <span className="mono forensics-ip">{session.from || '—'}</span>
                    <span>
                      {parsedStart ? (
                        <span className="forensics-time-group" title={session.start}>
                          <span className="time-val">{parsedStart.time}</span>
                          <span className="date-val">{parsedStart.date}</span>
                        </span>
                      ) : (
                        <span className="mono forensics-dim">{session.start}</span>
                      )}
                    </span>
                    <span>
                      {isLive ? (
                        <span className={`forensics-badge ${isSelf ? 'is-current' : 'is-live'}`}>
                          <span className={`forensics-live-dot ${isSelf ? 'is-current' : ''}`} /> {isSelf ? 'tu sesión' : 'en sesión'}
                        </span>
                      ) : parsedEnd ? (
                        <span className="forensics-time-group" title={session.end}>
                          <span className="time-val">{parsedEnd.time}</span>
                          <span className="date-val">{parsedEnd.date}</span>
                        </span>
                      ) : (
                        <span className="mono forensics-dim">{session.end || '—'}</span>
                      )}
                    </span>
                    <span className="forensics-duration">
                      <ClockIcon size={11} />
                      <span className="mono">{session.duration || '—'}</span>
                    </span>
                    <span>
                      {isSelf ? (
                        <span className="forensics-badge is-current" title="Esta es tu sesión SSH actual">
                          <span className="forensics-live-dot is-current" /> actual
                        </span>
                      ) : isLive ? (
                        <span className="forensics-badge is-live">
                          <span className="forensics-live-dot" /> activa
                        </span>
                      ) : (
                        <span className="forensics-badge is-closed">cerrada</span>
                      )}
                    </span>
                    <span className="forensics-actions">
                      {session.from && session.from !== '—' && !isSelf && (
                        blockedIps.includes(session.from) ? (
                          <button
                            type="button"
                            className="forensics-block-btn is-unblock"
                            onClick={() => void unblockIp(session.from)}
                            disabled={blocking === session.from}
                            title={`Desbloquear ${session.from}`}
                          >
                            <ShieldOffIcon size={11} />
                            {blocking === session.from ? '…' : 'Desbloquear'}
                          </button>
                        ) : (
                          <button
                            type="button"
                            className="forensics-block-btn"
                            onClick={() => void blockIp(session.from)}
                            disabled={blocking === session.from}
                            title={`Bloquear ${session.from} en firewall`}
                          >
                            <ShieldIcon size={11} />
                            {blocking === session.from ? '…' : 'Bloquear'}
                          </button>
                        )
                      )}
                      {isSelf && (
                        <span className="forensics-badge is-self-tag" title="Conexión activa en uso por Nexshell">
                          en uso
                        </span>
                      )}
                    </span>
                  </div>
                )
              })}
              {filteredSessions.length === 0 && (
                <div className="process-table__empty">Sin sesiones.</div>
              )}
            </div>
          </div>
        </>
      )}
      {section === 'auth' && (
        <>
          {authOk > 0 && (
            <div className="inline-alert inline-alert--warn">
              <AlertIcon size={15} />
              <span>
                {authOk} autenticación(es) correctas. Revisa usuario, IP y método: cualquier
                éxito que no reconozcas es un acceso real.
              </span>
            </div>
          )}
          <div className="forensics-toolbar">
            <div className="forensics-filter-pills">
              <button
                type="button"
                className={`forensics-pill ${statusFilter === 'all' ? 'is-active' : ''}`}
                onClick={() => setStatusFilter('all')}
              >
                Todos <span className="forensics-pill-count">{attempts.length}</span>
              </button>
              <button
                type="button"
                className={`forensics-pill is-fail ${statusFilter === 'failed' ? 'is-active' : ''}`}
                onClick={() => setStatusFilter('failed')}
              >
                Fallos <span className="forensics-pill-count">{failedCount}</span>
              </button>
              <button
                type="button"
                className={`forensics-pill is-ok ${statusFilter === 'success' ? 'is-active' : ''}`}
                onClick={() => setStatusFilter('success')}
              >
                Éxitos <span className="forensics-pill-count">{successCount}</span>
              </button>
              <button
                type="button"
                className={`forensics-pill is-blocked-pill ${statusFilter === 'blocked' ? 'is-active' : ''}`}
                onClick={() => setStatusFilter('blocked')}
              >
                Bloqueadas <span className="forensics-pill-count">{blockedAttemptsCount}</span>
              </button>
            </div>
            <div className="db-search forensics-filter">
              <SearchIcon size={13} />
              <input
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Filtrar por usuario, IP, método o detalle…"
                spellCheck={false}
              />
              {filter && (
                <button
                  type="button"
                  className="ghost-button forensics-search-clear"
                  onClick={() => setFilter('')}
                  title="Limpiar filtro"
                >
                  <XIcon size={12} />
                </button>
              )}
            </div>
            <button className="primary-button" onClick={() => void run('auth')} disabled={loading.auth}>
              <RefreshIcon size={13} className={loading.auth ? 'spin' : ''} />
              {loading.auth ? 'Leyendo…' : 'Actualizar'}
            </button>
          </div>
          <div className="network-block">
            <header>
              <h3>
                <ShieldIcon size={13} /> Intentos de autenticación SSH
              </h3>
              <span>
                {processedAttempts.length}
                {processedAttempts.length !== attempts.length
                  ? ` de ${attempts.length}`
                  : ` (${authIps.length} IPs)`}
              </span>
            </header>
            <div className="forensics-table forensics-table--auth">
              <div className="forensics-row forensics-row--head">
                <button
                  type="button"
                  className={`forensics-sort-btn ${authSortField === 'timestamp' ? 'is-active' : ''}`}
                  onClick={() => toggleAuthSort('timestamp')}
                  title="Ordenar por hora"
                >
                  <span>HORA</span>
                  <span className="forensics-sort-indicator">
                    {authSortField === 'timestamp' ? (
                      authSortDir === 'asc' ? <ChevronUpIcon size={12} /> : <ChevronDownIcon size={12} />
                    ) : null}
                  </span>
                </button>
                <button
                  type="button"
                  className={`forensics-sort-btn ${authSortField === 'user' ? 'is-active' : ''}`}
                  onClick={() => toggleAuthSort('user')}
                  title="Ordenar por usuario"
                >
                  <span>USUARIO</span>
                  <span className="forensics-sort-indicator">
                    {authSortField === 'user' ? (
                      authSortDir === 'asc' ? <ChevronUpIcon size={12} /> : <ChevronDownIcon size={12} />
                    ) : null}
                  </span>
                </button>
                <button
                  type="button"
                  className={`forensics-sort-btn ${authSortField === 'from' ? 'is-active' : ''}`}
                  onClick={() => toggleAuthSort('from')}
                  title="Ordenar por IP de origen"
                >
                  <span>ORIGEN</span>
                  <span className="forensics-sort-indicator">
                    {authSortField === 'from' ? (
                      authSortDir === 'asc' ? <ChevronUpIcon size={12} /> : <ChevronDownIcon size={12} />
                    ) : null}
                  </span>
                </button>
                <button
                  type="button"
                  className={`forensics-sort-btn ${authSortField === 'method' ? 'is-active' : ''}`}
                  onClick={() => toggleAuthSort('method')}
                  title="Ordenar por método"
                >
                  <span>MÉTODO</span>
                  <span className="forensics-sort-indicator">
                    {authSortField === 'method' ? (
                      authSortDir === 'asc' ? <ChevronUpIcon size={12} /> : <ChevronDownIcon size={12} />
                    ) : null}
                  </span>
                </button>
                <button
                  type="button"
                  className={`forensics-sort-btn ${authSortField === 'status' ? 'is-active' : ''}`}
                  onClick={() => toggleAuthSort('status')}
                  title="Ordenar por estado"
                >
                  <span>ESTADO</span>
                  <span className="forensics-sort-indicator">
                    {authSortField === 'status' ? (
                      authSortDir === 'asc' ? <ChevronUpIcon size={12} /> : <ChevronDownIcon size={12} />
                    ) : null}
                  </span>
                </button>
                <span className="forensics-th-label">ACCIÓN</span>
              </div>
              {processedAttempts.map((item, index) => (
                <div className="forensics-row" key={`${item.timestamp}-${item.user}-${index}`}>
                  <span className="mono forensics-time-val">{item.timestamp}</span>
                  <span className={`mono forensics-user ${item.user === 'root' ? 'is-root' : ''}`}>
                    {item.user || '—'}
                  </span>
                  <span className="mono forensics-ip">{item.from || '—'}</span>
                  <span>
                    <span className="mono forensics-method">{item.method || '—'}</span>
                  </span>
                  <span>
                    <span
                      className={`forensics-badge ${
                        item.status === 'success' ? 'is-success' : 'is-failed'
                      }`}
                    >
                      {item.status === 'success' ? 'éxito' : 'fallo'}
                    </span>
                  </span>
                  <span className="forensics-actions">
                    {item.from && item.from !== '—' && (
                      blockedIps.includes(item.from) ? (
                        <button
                          type="button"
                          className="forensics-block-btn is-unblock"
                          onClick={() => void unblockIp(item.from)}
                          disabled={blocking === item.from}
                          title={`Desbloquear IP ${item.from}`}
                        >
                          <ShieldOffIcon size={11} />
                          {blocking === item.from ? '…' : 'Desbloquear'}
                        </button>
                      ) : item.status === 'failed' ? (
                        <button
                          type="button"
                          className="forensics-block-btn"
                          onClick={() => void blockIp(item.from)}
                          disabled={blocking === item.from}
                          title={`Bloquear IP ${item.from}`}
                        >
                          <ShieldIcon size={11} />
                          {blocking === item.from ? '…' : 'Bloquear'}
                        </button>
                      ) : null
                    )}
                  </span>
                </div>
              ))}
              {processedAttempts.length === 0 && (
                <div className="process-table__empty">
                  {attempts.length === 0
                    ? 'Sin intentos en los logs disponibles (auth.log/secure/journalctl).'
                    : 'No se encontraron intentos que coincidan con los filtros aplicados.'}
                </div>
              )}
            </div>
          </div>
        </>
      )}
      {section === 'artifacts' && (
        <>
          {aiTools.length > 0 && (
            <div className="inline-alert inline-alert--warn">
              <AlertIcon size={15} />
              <span>
                {aiTools.length} directorio(s) de IDE/CLI de IA en esta ruta. Revisa su fecha de
                creación: si no los instalaste tú, son acceso interactivo de alguien más.
              </span>
            </div>
          )}
          <div className="network-block">
            <header>
              <h3>
                <FolderIcon size={13} /> Artefactos en {path}
              </h3>
              <span>{artifacts.length}</span>
            </header>
            <div className="forensics-table forensics-table--artifacts">
              <div className="forensics-row forensics-row--head">
                <span>NOMBRE</span>
                <span>TIPO</span>
                <span>TAG</span>
                <span>CREADO</span>
                <span>MODIFICADO</span>
                <span>TAMAÑO</span>
              </div>
              {artifacts.map((item) => (
                <div className="forensics-row" key={item.path}>
                  <span className="mono forensics-name" title={item.path}>{item.name}</span>
                  <span className="mono forensics-dim">{item.kind}</span>
                  <span>
                    <span className={`forensics-badge tag-${item.tag}`}>{item.tag}</span>
                  </span>
                  <span className="mono forensics-dim">{item.birth}</span>
                  <span className="mono forensics-dim">{item.change}</span>
                  <span className="mono">{item.sizeHuman}</span>
                </div>
              ))}
              {artifacts.length === 0 && (
                <div className="process-table__empty">Sin datos. Pulsa Escanear.</div>
              )}
            </div>
          </div>
        </>
      )}
      {section === 'search' && (
        <div className="network-block">
          <header>
            <h3>
              <SearchIcon size={13} /> Coincidencias en {path}
            </h3>
            <span>{hits.length}</span>
          </header>
          <div className="forensics-hits">
            {hits.map((hit, index) => (
              <div className="forensics-hit" key={`${hit.path}-${hit.line}-${index}`}>
                <span className="mono forensics-hit__path" title={hit.path}>
                  {hit.path}:{hit.line}
                </span>
                <span className="mono forensics-hit__text">{hit.text}</span>
              </div>
            ))}
            {hits.length === 0 && (
              <div className="process-table__empty">Sin coincidencias.</div>
            )}
          </div>
        </div>
      )}
      {section === 'secrets' && (
        <>
          <div className="inline-alert inline-alert--warn">
            <AlertIcon size={15} />
            <span>
              Solo se muestran ruta, línea y tipo. Los valores nunca se envían a la interfaz.
            </span>
          </div>
          <div className="network-block">
            <header>
              <h3>
                <KeyIcon size={13} /> Credenciales detectadas en {path}
              </h3>
              <span>{secrets.length}</span>
            </header>
            <div className="forensics-table forensics-table--secrets">
              <div className="forensics-row forensics-row--head">
                <span>ARCHIVO</span>
                <span>LÍNEA</span>
                <span>TIPO</span>
              </div>
              {secrets.map((secret, index) => (
                <div className="forensics-row" key={`${secret.path}-${secret.line}-${index}`}>
                  <span className="mono forensics-name" title={secret.path}>{secret.path}</span>
                  <span className="mono">{secret.line}</span>
                  <span className="forensics-badge is-secret">{secret.kind}</span>
                </div>
              ))}
              {secrets.length === 0 && (
                <div className="process-table__empty">Sin credenciales detectadas.</div>
              )}
            </div>
          </div>
        </>
      )}
    </div>
  )
}
