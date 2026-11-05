import {
  AlertIcon,
  ClockIcon,
  FolderIcon,
  KeyIcon,
  RefreshIcon,
  SearchIcon,
  ShieldIcon,
  TerminalIcon,
} from '@/components/Icons'

import { useForensicsView } from './useForensicsView'

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
    uniqueIps,
  } = useForensicsView(profileId)

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
            </button>
          ))}
        </div>
        <div className="forensics-stats">
          {section === 'sessions' && (
            <>
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
      </div>
      {error && (
        <div className="inline-alert inline-alert--error">
          <AlertIcon size={15} />
          <span>{error}</span>
        </div>
      )}
      {section !== 'sessions' && (
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
          <button className="primary-button" onClick={() => void run(section)} disabled={loading}>
            {section === 'search' ? (
              <SearchIcon size={13} />
            ) : (
              <RefreshIcon size={13} className={loading ? 'spin' : ''} />
            )}
            {loading ? 'Ejecutando…' : section === 'search' ? 'Buscar' : 'Escanear'}
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
            <button className="primary-button" onClick={() => void run('sessions')} disabled={loading}>
              <RefreshIcon size={13} className={loading ? 'spin' : ''} />
              {loading ? 'Leyendo…' : 'Actualizar'}
            </button>
          </div>
          <div className="network-block">
            <header>
              <h3>
                <ClockIcon size={13} /> Historial de accesos (last -aF)
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

                return (
                  <div className="forensics-row" key={`${session.user}-${session.tty}-${session.start}-${index}`}>
                    <span className={`mono forensics-user ${session.user === 'root' ? 'is-root' : ''}`}>
                      {session.user}
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
                        <span className="forensics-badge is-live">
                          <span className="forensics-live-dot" /> en sesión
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
                      {isLive ? (
                        <span className="forensics-badge is-live">
                          <span className="forensics-live-dot" /> activa
                        </span>
                      ) : (
                        <span className="forensics-badge is-closed">cerrada</span>
                      )}
                    </span>
                    <span className="forensics-actions">
                      {session.from && session.from !== '—' && (
                        <button
                          className={`forensics-block-btn ${
                            blockedIps.includes(session.from) ? 'is-blocked' : ''
                          }`}
                          onClick={() => void blockIp(session.from)}
                          disabled={blocking === session.from || blockedIps.includes(session.from)}
                          title={`Bloquear ${session.from} en firewall`}
                        >
                          <ShieldIcon size={11} />
                          {blockedIps.includes(session.from)
                            ? 'Bloqueada'
                            : blocking === session.from
                              ? '…'
                              : 'Bloquear'}
                        </button>
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
            <div className="db-search forensics-filter">
              <SearchIcon size={13} />
              <input
                value={filter}
                onChange={(event) => setFilter(event.target.value)}
                placeholder="Filtrar por usuario, IP o estado…"
                spellCheck={false}
              />
            </div>
            <button className="primary-button" onClick={() => void run('auth')} disabled={loading}>
              <RefreshIcon size={13} className={loading ? 'spin' : ''} />
              {loading ? 'Leyendo…' : 'Actualizar'}
            </button>
          </div>
          <div className="network-block">
            <header>
              <h3>
                <ShieldIcon size={13} /> Intentos de autenticación SSH
              </h3>
              <span>{attempts.length}</span>
            </header>
            <div className="forensics-table forensics-table--auth">
              <div className="forensics-row forensics-row--head">
                <span>HORA</span>
                <span>USUARIO</span>
                <span>ORIGEN</span>
                <span>MÉTODO</span>
                <span>ESTADO</span>
                <span>ACCIÓN</span>
              </div>
              {attempts
                .filter((item) =>
                  [item.user, item.from, item.status, item.method]
                    .join(' ')
                    .toLowerCase()
                    .includes(filter.trim().toLowerCase()),
                )
                .map((item, index) => (
                  <div className="forensics-row" key={`${item.timestamp}-${item.user}-${index}`}>
                    <span className="mono forensics-dim">{item.timestamp}</span>
                    <span className={`mono forensics-user ${item.user === 'root' ? 'is-root' : ''}`}>
                      {item.user || '—'}
                    </span>
                    <span className="mono forensics-ip">{item.from || '—'}</span>
                    <span className="mono forensics-dim">{item.method || '—'}</span>
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
                      {item.status === 'failed' && item.from && (
                        <button
                          className={`forensics-block-btn ${
                            blockedIps.includes(item.from) ? 'is-blocked' : ''
                          }`}
                          onClick={() => void blockIp(item.from)}
                          disabled={blocking === item.from || blockedIps.includes(item.from)}
                          title={`Bloquear ${item.from}`}
                        >
                          <ShieldIcon size={11} />
                          {blockedIps.includes(item.from)
                            ? 'Bloqueada'
                            : blocking === item.from
                              ? '…'
                              : 'Bloquear'}
                        </button>
                      )}
                    </span>
                  </div>
                ))}
              {attempts.length === 0 && (
                <div className="process-table__empty">
                  Sin intentos en los logs disponibles (auth.log/secure/journalctl).
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
