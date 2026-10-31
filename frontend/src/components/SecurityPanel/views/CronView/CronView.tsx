import { AlertIcon, ClockIcon, RefreshIcon, RestartIcon, SearchIcon, TrashIcon, XIcon } from '@/components/Icons'

import { useCronView } from './useCronView'

export function CronView({ profileId }: { profileId: string }) {
  const { backups, canDelete, deleteEntry, deleteError, deleteTarget, deleting, entries, error, load, loading, report, restoreBackup, restoring, search, setDeleteError, setDeleteTarget, setSearch } = useCronView(profileId)


  return (
    <div className="security-view">
      <div className="security-toolbar">
        <button className="primary-button" onClick={() => void load()} disabled={loading}>
          <RefreshIcon size={14} className={loading ? 'spin' : ''} />
          {loading ? 'Reading cron…' : 'Refresh cron'}
        </button>
        <div className="db-search cron-search">
          <SearchIcon size={14} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Filter jobs…"
            spellCheck={false}
          />
        </div>
        {report && (
          <span className="security-meta">
            {report.hostname} · cron service: {report.serviceState}
          </span>
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
          <div className="cron-table">
            <div className="cron-row cron-row--head">
              <span>SOURCE</span>
              <span>SCHEDULE</span>
              <span>USER</span>
              <span>COMMAND</span>
              <span>ACTIONS</span>
            </div>
            {entries.map((entry, index) => (
              <div
                className={`cron-row ${entry.suspicious ? 'is-suspicious' : ''}`}
                key={`${entry.source}-${index}`}
              >
                <span className="mono cron-source" title={entry.source}>
                  {entry.source}
                </span>
                <span className="mono">{entry.schedule}</span>
                <span className="mono">{entry.user ?? '—'}</span>
                <span className="mono cron-command" title={entry.command}>
                  {entry.suspicious && <AlertIcon size={12} />}
                  {entry.command}
                </span>
                <div className="cron-actions">
                  {canDelete(entry) && (
                    <button
                      className="icon-button is-danger"
                      title="Delete this cron entry"
                      onClick={() => {
                        setDeleteTarget(entry)
                        setDeleteError(null)
                      }}
                    >
                      <TrashIcon size={13} />
                    </button>
                  )}
                </div>
              </div>
            ))}
            {entries.length === 0 && (
              <div className="large-files-empty">No cron entries returned.</div>
            )}
          </div>

          {report.timers.length > 0 && (
            <details className="cron-timers">
              <summary>
                <ClockIcon size={13} /> systemd timers ({report.timers.length})
              </summary>
              <pre>{report.timers.join('\n')}</pre>
            </details>
          )}
          {report.atJobs.length > 0 && (
            <details className="cron-timers">
              <summary>at jobs ({report.atJobs.length})</summary>
              <pre>{report.atJobs.join('\n')}</pre>
            </details>
          )}
          {deleteTarget && (
            <div
              className="modal-backdrop"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget && !deleting) {
                  setDeleteTarget(null)
                }
              }}
            >
              <div className="modal modal--compact" role="dialog" aria-modal="true">
                <header className="modal__header">
                  <div>
                    <h2>Delete cron entry</h2>
                    <p>
                      The server creates a backup before removing the line.
                    </p>
                  </div>
                  <button
                    className="icon-button"
                    onClick={() => setDeleteTarget(null)}
                    disabled={deleting}
                    title="Close"
                  >
                    <XIcon size={16} />
                  </button>
                </header>
                <div className="modal__body">
                  <div className="process-summary">
                    <div>
                      <span>Source</span>
                      <strong className="mono">{deleteTarget.source}</strong>
                    </div>
                    <div>
                      <span>Schedule</span>
                      <strong className="mono">{deleteTarget.schedule}</strong>
                    </div>
                    <div>
                      <span>User</span>
                      <strong className="mono">{deleteTarget.user ?? '—'}</strong>
                    </div>
                    <code>{deleteTarget.raw}</code>
                  </div>
                  {deleteTarget.suspicious ? (
                    <div className="inline-alert inline-alert--error">
                      <AlertIcon size={15} />
                      <span>
                        Entrada marcada como sospechosa. Se guarda un backup en
                        /var/backups/2shell/cron antes de modificarla.
                      </span>
                    </div>
                  ) : (
                    <div className="inline-alert inline-alert--warn">
                      <AlertIcon size={15} />
                      <span>
                        Esta entrada NO está marcada como sospechosa. Si es una tarea
                        legítima del sistema puedes romper anacron, certbot o el agente del
                        proveedor. El backup permite restaurarla después.
                      </span>
                    </div>
                  )}
                  {deleteError && (
                    <div className="inline-alert inline-alert--error">
                      <AlertIcon size={15} />
                      <span>{deleteError}</span>
                    </div>
                  )}
                </div>
                <footer className="modal__footer">
                  <button
                    className="ghost-button"
                    onClick={() => setDeleteTarget(null)}
                    disabled={deleting}
                  >
                    Cancel
                  </button>
                  <button
                    className="danger-button"
                    onClick={() => void deleteEntry()}
                    disabled={deleting}
                  >
                    <TrashIcon size={14} /> {deleting ? 'Removing…' : 'Delete entry'}
                  </button>
                </footer>
              </div>
            </div>
          )}

          {backups.length > 0 && (
            <details className="cron-timers">
              <summary>
                <ClockIcon size={13} /> backups de cron ({backups.length})
              </summary>
              <div className="cron-backups">
                {backups.map((backup) => (
                  <div className="cron-backup-row" key={backup.id}>
                    <div>
                      <strong className="mono">{backup.source}</strong>
                      <span>
                        {new Date(backup.timestamp * 1000).toLocaleString()} ·{' '}
                        {backup.removed} entrada(s) · {backup.backupPath}
                      </span>
                    </div>
                    <button
                      className="top-action"
                      onClick={() => void restoreBackup(backup)}
                      disabled={restoring !== null}
                    >
                      <RestartIcon size={12} /> {restoring === backup.id ? 'Restaurando…' : 'Restaurar'}
                    </button>
                  </div>
                ))}
              </div>
            </details>
          )}

          {report.recent.length > 0 && (
            <details className="cron-timers">
              <summary>
                <ClockIcon size={13} /> recent cron activity ({report.recent.length})
              </summary>
              <pre>{report.recent.join('\n')}</pre>
            </details>
          )}
          {report.errors.length > 0 && (
            <details className="cron-timers">
              <summary>anacrontab / notes ({report.errors.length})</summary>
              <pre>{report.errors.join('\n')}</pre>
            </details>
          )}
        </>
      )}
    </div>
  )
}
