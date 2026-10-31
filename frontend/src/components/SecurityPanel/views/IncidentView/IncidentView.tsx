import { AlertIcon, SearchIcon, XIcon } from '@/components/Icons'

import { useIncidentView } from './useIncidentView'

export function IncidentView({ profileId }: { profileId: string }) {
  const { actionError, apply, askKill, askQuarantine, block, blocked, confirm, counts, error, load, loading, running, scan, setConfirm } = useIncidentView(profileId)


  return (
    <div className="security-view">
      <div className="security-toolbar">
        <button className="primary-button" onClick={() => void load()} disabled={loading}>
          <SearchIcon size={14} className={loading ? 'spin' : ''} />
          {loading ? 'Escaneando…' : 'Escanear host'}
        </button>
        <span className="security-meta">
          procesos, binarios en /tmp, entornos, conexiones, claves y contenedores
        </span>
      </div>

      {error && (
        <div className="inline-alert inline-alert--error">
          <AlertIcon size={15} />
          <span>{error}</span>
        </div>
      )}

      {!scan ? (
        <div className="large-files-empty">
          <AlertIcon size={24} />
          <strong>Sin escaneo todavía</strong>
          <p>
            El escaneo busca procesos ejecutándose desde directorios temporales, binarios
            y scripts ocultos, variables de entorno sospechosas, conexiones salientes,
            claves autorizadas, historial de root y contenedores.
          </p>
        </div>
      ) : (
        <>
          <div className="incident-summary">
            <div className={counts.processes > 0 ? 'is-critical' : 'is-ok'}>
              <span>procesos</span>
              <strong>{counts.processes}</strong>
            </div>
            <div className={counts.files > 0 ? 'is-warn' : 'is-ok'}>
              <span>archivos /tmp</span>
              <strong>{counts.files}</strong>
            </div>
            <div className={counts.env > 0 ? 'is-critical' : 'is-ok'}>
              <span>entornos</span>
              <strong>{counts.env}</strong>
            </div>
            <div className="is-info">
              <span>conexiones</span>
              <strong>{counts.connections}</strong>
            </div>
          </div>

          <section className="incident-block">
            <header>
              <h3>Procesos desde directorios temporales</h3>
              <span>{scan.hostname} · {counts.processes}</span>
            </header>
            {scan.processes.length === 0 ? (
              <p className="incident-empty">Ninguno. Buen indicador.</p>
            ) : (
              scan.processes.map((process) => (
                <div className="incident-row" key={`${process.pid}-${process.exe}`}>
                  <div className="incident-row__main">
                    <strong className="mono">PID {process.pid}</strong>
                    <span className="mono">{process.user}</span>
                    <span className="mono incident-exe">{process.exe}</span>
                  </div>
                  <span className="mono incident-cmd" title={process.command}>
                    {process.command || '—'}
                  </span>
                  <button
                    className="danger-outline-button"
                    onClick={() => askKill(process)}
                    disabled={running}
                  >
                    Matar
                  </button>
                </div>
              ))
            )}
          </section>

          <section className="incident-block">
            <header>
              <h3>Archivos ejecutables u ocultos en /tmp, /dev/shm, /var/tmp</h3>
              <span>{counts.files}</span>
            </header>
            {scan.files.length === 0 ? (
              <p className="incident-empty">Nada sospechoso en los directorios temporales.</p>
            ) : (
              scan.files.map((file) => (
                <div className="incident-row" key={file.path}>
                  <div className="incident-row__main">
                    <span className="mono incident-exe">{file.path}</span>
                  </div>
                  <span className="mono incident-cmd">
                    {file.mode} {file.owner} · {file.size} B · {file.modified}
                  </span>
                  <button
                    className="top-action"
                    onClick={() => askQuarantine(file)}
                    disabled={running}
                  >
                    Cuarentena
                  </button>
                </div>
              ))
            )}
          </section>

          {scan.envHits.length > 0 && (
            <section className="incident-block">
              <header>
                <h3>Variables de entorno sospechosas</h3>
                <span>{scan.envHits.length}</span>
              </header>
              <pre className="incident-pre">{scan.envHits.join('\n')}</pre>
            </section>
          )}

          <section className="incident-block">
            <header>
              <h3>Conexiones establecidas</h3>
              <span>{counts.connections}</span>
            </header>
            {scan.connections.length === 0 ? (
              <p className="incident-empty">Sin conexiones externas establecidas.</p>
            ) : (
              scan.connections.map((connection) => (
                <div className="incident-row" key={`${connection.local}-${connection.remote}`}>
                  <div className="incident-row__main">
                    <span className="mono incident-exe">{connection.remote}</span>
                    <span className="mono">{connection.process || '?'}</span>
                    {connection.pid !== null && (
                      <span className="mono">pid {connection.pid}</span>
                    )}
                  </div>
                  <span className="mono incident-cmd">{connection.local}</span>
                  <button
                    className={blocked.includes(connection.ip) ? 'top-action' : 'danger-outline-button'}
                    onClick={() => void block(connection.ip)}
                    disabled={blocked.includes(connection.ip)}
                  >
                    {blocked.includes(connection.ip) ? 'Bloqueada' : 'Bloquear IP'}
                  </button>
                </div>
              ))
            )}
          </section>

          <div className="incident-details">
            <details>
              <summary>Claves autorizadas ({scan.authorizedKeys.length} líneas)</summary>
              <pre>{scan.authorizedKeys.join('\n') || 'sin claves'}</pre>
            </details>
            <details>
              <summary>Historial de root ({scan.shellHistory.length} líneas)</summary>
              <pre>{scan.shellHistory.join('\n') || 'vacío'}</pre>
            </details>
            <details>
              <summary>Contenedores ({scan.containers.length})</summary>
              <pre>{scan.containers.join('\n') || 'sin docker'}</pre>
            </details>
            <details>
              <summary>Servicios activos ({scan.units.length})</summary>
              <pre>{scan.units.join('\n')}</pre>
            </details>
          </div>
        </>
      )}

      {confirm && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !running) setConfirm(null)
          }}
        >
          <div className="modal modal--compact" role="dialog" aria-modal="true">
            <header className="modal__header">
              <div>
                <h2>{confirm.title}</h2>
                <p>Acción registrada en el audit log.</p>
              </div>
              <button
                className="icon-button"
                onClick={() => setConfirm(null)}
                disabled={running}
                title="Cerrar"
              >
                <XIcon size={16} />
              </button>
            </header>
            <div className="modal__body">
              <pre className="incident-pre">{confirm.detail}</pre>
              <div className="inline-alert inline-alert--error">
                <AlertIcon size={15} />
                <span>
                  {confirm.kind === 'kill'
                    ? 'SIGKILL inmediato. Si un supervisor lo relanza, primero detén el servicio (pm2/systemd).'
                    : 'El archivo se mueve a /var/backups/2shell/quarantine con permisos 000. Se guarda su sha256 en la salida de la acción.'}
                </span>
              </div>
              {actionError && (
                <div className="inline-alert inline-alert--error">
                  <AlertIcon size={15} />
                  <span>{actionError}</span>
                </div>
              )}
            </div>
            <footer className="modal__footer">
              <button
                className="ghost-button"
                onClick={() => setConfirm(null)}
                disabled={running}
              >
                Cancelar
              </button>
              <button
                className="danger-button"
                onClick={() => void apply()}
                disabled={running}
              >
                {running ? 'Aplicando…' : confirm.kind === 'kill' ? 'Matar proceso' : 'Mover a cuarentena'}
              </button>
            </footer>
          </div>
        </div>
      )}
    </div>
  )
}
