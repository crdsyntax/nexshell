import { AlertIcon, CheckIcon, ShieldIcon, TrashIcon, XIcon } from '@/components/Icons'

import { useSudoersView } from './useSudoersView'

export function SudoersView({ profileId }: { profileId: string }) {
  const { actionError, apply, busy, error, load, loading, nopasswd, openOrigin, origin, originError, originLoading, originUser, privilegedUsers, report, setActionError, setOrigin, setOriginUser, setTarget, target } = useSudoersView(profileId)


  return (
    <div className="security-view">
      <div className="sec-toolbar">
        <button className="primary-button" onClick={() => void load()} disabled={loading}>
          <ShieldIcon size={13} className={loading ? 'spin' : ''} />
          {loading ? 'Leyendo sudoers…' : 'Leer sudoers'}
        </button>
        {report && (
          <>
            <span className={`sec-status ${report.configOk ? 'is-ok' : 'is-bad'}`}>
              {report.configOk ? <CheckIcon size={11} /> : <AlertIcon size={11} />}
              visudo -c: {report.configOk ? 'syntax valid' : 'errors'}
            </span>
            <span className="sec-toolbar__meta">
              {report.rules.length} REGLAS ACTIVAS · {nopasswd} CON NOPASSWD ·{' '}
              {report.accounts.length} CUENTAS REGISTRADAS
            </span>
          </>
        )}
      </div>

      {error && (
        <div className="inline-alert inline-alert--error">
          <AlertIcon size={15} />
          <span>{error}</span>
        </div>
      )}

      {report && (
        <>
          {nopasswd > 0 && (
            <div className="risk-banner">
              <span className="risk-banner__icon">
                <AlertIcon size={15} />
              </span>
              <div className="risk-banner__body">
                <strong>
                  Exposición crítica: {nopasswd} regla(s) permiten sudo sin contraseña
                </strong>
                <p>
                  Revisa que cada regla esté limitada al comando exacto necesario. Una regla
                  NOPASSWD: ALL equivale a root sin barrera.
                </p>
              </div>
              <button
                className="risk-banner__cta"
                onClick={() =>
                  document
                    .querySelector('.sudoers-rules')
                    ?.scrollIntoView({ behavior: 'smooth', block: 'center' })
                }
              >
                Examinar riesgo
              </button>
            </div>
          )}

          <div className="sudoers-grid">
          <div className="sudoers-col">
          <section className="network-block">
            <header>
              <h3><ShieldIcon size={12} /> Grupos con privilegios</h3>
              <span>{privilegedUsers.length} usuarios</span>
            </header>
            <div className="sudoers-table">
              <div className="sudoers-row sudoers-row--head">
                <span>GRUPO</span>
                <span>GID</span>
                <span>MIEMBROS</span>
              </div>
              {report.groups.map((group) => (
                <div className="sudoers-row" key={group.name}>
                  <span className="mono">{group.name}</span>
                  <span className="mono">{group.gid}</span>
                  <span className="mono sudoers-members">
                    {group.members.length > 0 ? group.members.join(', ') : '—'}
                  </span>
                </div>
              ))}
              {report.groups.length === 0 && (
                <div className="process-table__empty">
                  No se encontraron grupos wheel/sudo/admin.
                </div>
              )}
            </div>
          </section>

          <section className="network-block">
            <header>
              <h3>Cuentas referenciadas</h3>
              <span>{report.accounts.length}</span>
            </header>
            <div className="sudoers-table sudoers-table--accounts">
              <div className="sudoers-row sudoers-row--head">
                <span>USUARIO</span>
                <span>UID</span>
                <span>SHELL</span>
                <span>PASSWORD</span>
                <span>ÚLTIMO LOGIN</span>
                <span>CLAVES</span>
                <span>ACCIONES</span>
              </div>
              {report.accounts.map((account) => (
                <div className="sudoers-row" key={account.user}>
                  <span className="mono sudoers-user" title={account.home || account.user}>
                    {account.user}
                    {!account.exists ? (
                      <span className="sudoers-orphan">NO EXISTE</span>
                    ) : (
                      <span
                        className={`sudoers-state ${
                          account.passwordStatus === 'L' ? 'is-locked' : 'is-active'
                        }`}
                      >
                        {account.passwordStatus === 'L' ? 'BLOQUEADA' : 'ACTIVO'}
                      </span>
                    )}
                  </span>
                  <span className="mono">{account.uid || '—'}</span>
                  <span className="mono sudoers-ellipsis" title={account.shell}>
                    {account.shell || '—'}
                  </span>
                  <span className="mono">
                    {account.passwordStatus === 'P'
                      ? 'activa'
                      : account.passwordStatus === 'L'
                        ? 'bloqueada'
                        : account.passwordStatus === 'NP'
                          ? 'sin clave'
                          : account.passwordStatus || '—'}
                  </span>
                  <span className="mono sudoers-ellipsis" title={account.lastLogin}>
                    {account.lastLogin || '—'}
                  </span>
                  <span className="mono">{account.authorizedKeys}</span>
                  <span className="sudoers-account-actions">
                    <button
                      className="top-action"
                      title="Ver quién creó la cuenta, desde qué IP y cuándo"
                      onClick={() => void openOrigin(account.user)}
                      disabled={busy}
                    >
                      Origen
                    </button>
                    {account.exists && account.user !== 'root' && (
                      <button
                        className={
                          account.passwordStatus === 'L'
                            ? 'top-action'
                            : 'danger-outline-button'
                        }
                        onClick={() => {
                          setActionError(null)
                          setTarget({
                            kind: account.passwordStatus === 'L' ? 'unlock' : 'lock',
                            account,
                          })
                        }}
                        disabled={busy}
                      >
                        {account.passwordStatus === 'L' ? 'Desbloquear' : 'Bloquear'}
                      </button>
                    )}
                  </span>
                </div>
              ))}
              {report.accounts.length === 0 && (
                <div className="process-table__empty">Sin cuentas referenciadas.</div>
              )}
            </div>
          </section>
          </div>

          <div className="sudoers-col sudoers-rules">
          <section className="network-block">
            <header>
              <h3><ShieldIcon size={12} /> Reglas de sudoers (/etc/sudoers)</h3>
              <span>{report.rules.length}</span>
            </header>
            <div className="sudoers-table sudoers-table--rules">
              <div className="sudoers-row sudoers-row--head">
                <span>USUARIO</span>
                <span>HOST</span>
                <span>RUNAS</span>
                <span>COMANDOS</span>
                <span>ORIGEN</span>
                <span>ACCIONES</span>
              </div>
              {report.rules.map((rule, index) => (
                <div className="sudoers-row" key={`${rule.source}-${rule.principal}-${index}`}>
                  <span className="mono sudoers-user">
                    {rule.principal}
                    {rule.nopasswd && <span className="sudoers-badge">NOPASSWD</span>}
                  </span>
                  <span className="mono">{rule.host}</span>
                  <span className="mono">{rule.runas || '—'}</span>
                  <span className="mono sudoers-commands" title={rule.commands}>
                    {rule.commands}
                  </span>
                  <span className="mono sudoers-source" title={rule.source}>
                    {rule.source}
                  </span>
                  <span className="sudoers-account-actions">
                    <button
                      className="icon-button is-danger"
                      title="Eliminar esta regla (con backup y visudo -c)"
                      onClick={() => {
                        setActionError(null)
                        setTarget({
                          kind: 'rule',
                          source: rule.source,
                          raw: rule.raw,
                          principal: rule.principal,
                        })
                      }}
                      disabled={busy}
                    >
                      <TrashIcon size={13} />
                    </button>
                  </span>
                </div>
              ))}
              {report.rules.length === 0 && (
                <div className="process-table__empty">Sin reglas explícitas.</div>
              )}
            </div>
            <div className="sudoers-ledger">
              <span>
                Cuentas UID 0: <strong>{report.rootAccounts.join(', ') || 'root'}</strong>
              </span>
            </div>
          </section>
          {!report.configOk && (
            <pre className="ssh-config-output">{report.configOutput}</pre>
          )}
          </div>
          </div>
        </>
      )}

      {originUser && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !originLoading) {
              setOriginUser(null)
              setOrigin(null)
            }
          }}
        >
          <div className="modal modal--logs" role="dialog" aria-modal="true">
            <header className="modal__header">
              <div>
                <h2>
                  Origen de la cuenta · {originUser}
                  <span className="panel__sub">{profileId}</span>
                </h2>
                <p>auditd, /var/log/secure, sudo, last y sistema de archivos.</p>
              </div>
              <button
                className="icon-button"
                onClick={() => {
                  setOriginUser(null)
                  setOrigin(null)
                }}
                disabled={originLoading}
                title="Cerrar"
              >
                <XIcon size={16} />
              </button>
            </header>
            <div className="modal__body pm2-logs-body">
              {originLoading && <div className="process-table__empty">buscando rastro…</div>}
              {originError && (
                <div className="inline-alert inline-alert--error">
                  <AlertIcon size={15} />
                  <span>{originError}</span>
                </div>
              )}
              {origin && (
                <>
                  <div className="origin-grid">
                    <div>
                      <span>Creada</span>
                      <strong className="mono">{origin.createdAt || 'desconocido'}</strong>
                    </div>
                    <div>
                      <span>Creada por</span>
                      <strong className="mono">{origin.createdBy || 'desconocido'}</strong>
                    </div>
                    <div>
                      <span>IP de origen</span>
                      <strong className="mono">{origin.sourceIp || 'desconocida'}</strong>
                    </div>
                    <div>
                      <span>Home</span>
                      <strong className="mono">
                        {origin.homeBirth || origin.homeChange || '—'}
                      </strong>
                    </div>
                    <div>
                      <span>Grupo</span>
                      <strong className="mono">{origin.group || '—'}</strong>
                    </div>
                    <div>
                      <span>auditd</span>
                      <strong className="mono">
                        {origin.auditAvailable ? 'con registros' : 'sin registros'}
                      </strong>
                    </div>
                  </div>

                  {origin.notes.length > 0 && (
                    <div className="inline-alert inline-alert--warn">
                      <AlertIcon size={15} />
                      <span>{origin.notes.join(' ')}</span>
                    </div>
                  )}

                  <div className="origin-section">
                    <h4>Eventos de creación</h4>
                    {origin.evidence.length === 0 ? (
                      <p className="process-table__empty">
                        Sin evidencia de creación en los logs disponibles.
                      </p>
                    ) : (
                      <div className="origin-events">
                        {origin.evidence.map((event, index) => (
                          <div className="origin-event" key={`${event.kind}-${index}`}>
                            <span className={`origin-kind kind-${event.kind}`}>{event.kind}</span>
                            <span className="mono origin-time">{event.timestamp || '—'}</span>
                            <span className="mono origin-actor">
                              {event.actor || '—'} {event.sourceIp ? `· ${event.sourceIp}` : ''}
                            </span>
                            <span className="mono origin-detail" title={event.detail}>
                              {event.detail}
                            </span>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>

                  <div className="origin-section">
                    <h4>Inicios de sesión ({origin.logins.length})</h4>
                    <pre className="pm2-log-pre origin-pre">
                      {origin.logins.join('\n') || 'sin registros en last'}
                    </pre>
                  </div>

                  {origin.sshLog.length > 0 && (
                    <details className="origin-section">
                      <summary>Accesos SSH de root ({origin.sshLog.length})</summary>
                      <pre className="pm2-log-pre origin-pre">{origin.sshLog.join('\n')}</pre>
                    </details>
                  )}

                  {origin.history.length > 0 && (
                    <details className="origin-section">
                      <summary>Historial de root ({origin.history.length})</summary>
                      <pre className="pm2-log-pre origin-pre">{origin.history.join('\n')}</pre>
                    </details>
                  )}
                </>
              )}
            </div>
            <footer className="modal__footer">
              <span className="field-hint">
                auditd es la fuente fiable; sin audit los logs pueden haberse borrado.
              </span>
              <button
                className="ghost-button"
                onClick={() => {
                  setOriginUser(null)
                  setOrigin(null)
                }}
              >
                Cerrar
              </button>
            </footer>
          </div>
        </div>
      )}

      {target && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !busy) setTarget(null)
          }}
        >
          <div className="modal modal--compact" role="dialog" aria-modal="true">
            <header className="modal__header">
              <div>
                <h2>
                  {target.kind === 'rule'
                    ? 'Eliminar regla de sudoers'
                    : target.kind === 'lock'
                      ? `Bloquear ${target.account.user}`
                      : `Desbloquear ${target.account.user}`}
                </h2>
                <p>
                  {target.kind === 'rule'
                    ? 'Se hace backup y se valida con visudo -c.'
                    : 'La cuenta conserva sus archivos; solo se cambia el estado de la contraseña.'}
                </p>
              </div>
              <button
                className="icon-button"
                onClick={() => setTarget(null)}
                disabled={busy}
                title="Cerrar"
              >
                <XIcon size={16} />
              </button>
            </header>
            <div className="modal__body">
              {target.kind === 'rule' ? (
                <>
                  <div className="process-summary">
                    <div>
                      <span>Usuario</span>
                      <strong className="mono">{target.principal}</strong>
                    </div>
                    <div>
                      <span>Origen</span>
                      <strong className="mono">{target.source}</strong>
                    </div>
                    <code>{target.raw}</code>
                  </div>
                  <div className="inline-alert inline-alert--error">
                    <AlertIcon size={15} />
                    <span>
                      Si es el único contenido del drop-in, se elimina el archivo. El backup
                      queda en /var/backups/2shell/sudoers.
                    </span>
                  </div>
                </>
              ) : (
                <div className="process-summary">
                  <div>
                    <span>Cuenta</span>
                    <strong className="mono">{target.account.user}</strong>
                  </div>
                  <div>
                    <span>UID</span>
                    <strong className="mono">{target.account.uid || '—'}</strong>
                  </div>
                  <div>
                    <span>Claves SSH</span>
                    <strong className="mono">{target.account.authorizedKeys}</strong>
                  </div>
                  <div>
                    <span>Último login</span>
                    <strong className="mono">{target.account.lastLogin || '—'}</strong>
                  </div>
                </div>
              )}
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
                onClick={() => setTarget(null)}
                disabled={busy}
              >
                Cancelar
              </button>
              <button
                className={target.kind === 'rule' ? 'danger-button' : 'primary-button'}
                onClick={() => void apply()}
                disabled={busy}
              >
                {busy
                  ? 'Aplicando…'
                  : target.kind === 'rule'
                    ? 'Eliminar regla'
                    : target.kind === 'lock'
                      ? 'Bloquear cuenta'
                      : 'Desbloquear cuenta'}
              </button>
            </footer>
          </div>
        </div>
      )}
    </div>
  )
}
