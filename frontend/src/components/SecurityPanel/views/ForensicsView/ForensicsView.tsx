import { AlertIcon, SearchIcon } from '@/components/Icons'

import { useForensicsView } from './useForensicsView'

export function ForensicsView({ profileId }: { profileId: string }) {
  const { aiTools, artifacts, attempts, authFailed, authIps, authOk, blockIp, blockedIps, blocking, error, filter, filteredSessions, hits, loading, path, query, regex, run, secrets, section, sessions, setFilter, setPath, setQuery, setRegex, setSection, uniqueIps } = useForensicsView(profileId)


  return (
    <div className="security-view">
      <div className="sec-toolbar">
        <div className="security-tabs">
          {(
            [
              ['sessions', 'Sesiones SSH'],
              ['auth', 'Intentos SSH'],
              ['artifacts', 'Artefactos'],
              ['search', 'Búsqueda'],
              ['secrets', 'Secretos'],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              className={section === value ? 'is-active' : ''}
              onClick={() => setSection(value)}
            >
              {label}
            </button>
          ))}
        </div>
        <span className="sec-toolbar__meta">
          {section === 'sessions' && `${sessions.length} sesiones · ${uniqueIps.length} IPs`}
          {section === 'auth' &&
            `${attempts.length} intentos · ${authFailed} fallidos · ${authOk} correctos`}
          {section === 'artifacts' && `${artifacts.length} entradas`}
          {section === 'search' && `${hits.length} coincidencias`}
          {section === 'secrets' && `${secrets.length} archivos`}
        </span>
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
              {loading ? 'Leyendo…' : 'Actualizar'}
            </button>
          </div>
          <div className="network-block">
            <header>
              <h3>Historial de accesos (last -aF)</h3>
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
              {filteredSessions.map((session, index) => (
                <div className="forensics-row" key={`${session.user}-${session.tty}-${session.start}-${index}`}>
                  <span className="mono">{session.user}</span>
                  <span className="mono">{session.tty}</span>
                  <span className="mono forensics-ip">{session.from || '—'}</span>
                  <span className="mono forensics-dim">{session.start}</span>
                  <span className="mono forensics-dim">{session.end || '—'}</span>
                  <span className="mono">{session.duration || '—'}</span>
                  <span>
                    {session.current ? (
                      <span className="forensics-badge is-live">activa</span>
                    ) : (
                      <span className="forensics-badge">cerrada</span>
                    )}
                  </span>
                  <span className="forensics-actions">
                    {session.from && session.from !== '—' && (
                      <button
                        className="danger-outline-button"
                        onClick={() => void blockIp(session.from)}
                        disabled={blocking === session.from || blockedIps.includes(session.from)}
                        title={`Bloquear ${session.from}`}
                      >
                        {blockedIps.includes(session.from)
                          ? 'bloqueada'
                          : blocking === session.from
                            ? '…'
                            : 'Bloquear'}
                      </button>
                    )}
                  </span>
                </div>
              ))}
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
            <span className="sec-toolbar__meta">{authIps.length} IPs distintas</span>
            <button className="primary-button" onClick={() => void run('auth')} disabled={loading}>
              {loading ? 'Leyendo…' : 'Actualizar'}
            </button>
          </div>
          <div className="network-block">
            <header>
              <h3>Intentos de autenticación SSH</h3>
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
                    <span className="mono">{item.user || '—'}</span>
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
                          className="danger-outline-button"
                          onClick={() => void blockIp(item.from)}
                          disabled={blocking === item.from || blockedIps.includes(item.from)}
                        >
                          {blockedIps.includes(item.from)
                            ? 'bloqueada'
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
              <h3>Artefactos en {path}</h3>
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
            <h3>Coincidencias en {path}</h3>
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
              <h3>Credenciales detectadas en {path}</h3>
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
