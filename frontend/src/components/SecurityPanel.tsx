import { useCallback, useEffect, useMemo, useState } from 'react'
import type { CSSProperties } from 'react'
import { useAppStore } from '@/store/useAppStore'
import { securityService } from '@/services/security.service'
import { cronService } from '@/services/cron.service'
import { sshService } from '@/services/ssh.service'
import { incidentService } from '@/services/incident.service'
import {
  AlertIcon,
  CheckIcon,
  ClockIcon,
  KeyIcon,
  PlusIcon,
  RefreshIcon,
  RestartIcon,
  SearchIcon,
  ShieldIcon,
  TrashIcon,
  WrenchIcon,
  XIcon,
} from '@/components/Icons'
import type {
  CronBackupSummary,
  CronEntry,
  CronReport,
  IncidentScan,
  SudoAccount,
  SudoersReport,
  SuspectFile,
  SuspectProcess,
  SecurityAuditSummary,
  SecurityFinding,
  SecurityReport,
  SshConfig,
  SshKey,
} from '@/types'

interface SecurityPanelProps {
  profileId: string
}

type SecurityView = 'audit' | 'cron' | 'incident' | 'sudoers' | 'ssh'

export function SecurityPanel({ profileId }: SecurityPanelProps) {
  const profiles = useAppStore((state) => state.profiles)
  const profile = profiles.find((item) => item.id === profileId)
  const [view, setView] = useState<SecurityView>('audit')

  return (
    <div className="panel security-panel">
      <div className="panel__header">
        <div>
          <div className="panel__eyebrow">
            <ShieldIcon size={14} /> security workspace
          </div>
          <h2>
            Security
            <span className="panel__sub">{profile?.name ?? profileId}</span>
          </h2>
          <p className="panel__description">
            Hardening audit, scheduled jobs and SSH key access for this host.
          </p>
        </div>
        <div className="security-tabs">
          <button
            className={view === 'audit' ? 'is-active' : ''}
            onClick={() => setView('audit')}
          >
            <ShieldIcon size={13} /> Audit
          </button>
          <button
            className={view === 'cron' ? 'is-active' : ''}
            onClick={() => setView('cron')}
          >
            <ClockIcon size={13} /> Cron
          </button>
          <button
            className={view === 'incident' ? 'is-active' : ''}
            onClick={() => setView('incident')}
          >
            <AlertIcon size={13} /> Incident
          </button>
          <button
            className={view === 'sudoers' ? 'is-active' : ''}
            onClick={() => setView('sudoers')}
          >
            <ShieldIcon size={13} /> Sudoers
          </button>
          <button
            className={view === 'ssh' ? 'is-active' : ''}
            onClick={() => setView('ssh')}
          >
            <KeyIcon size={13} /> SSH access
          </button>
        </div>
      </div>

      {view === 'audit' && <AuditView profileId={profileId} />}
      {view === 'cron' && <CronView profileId={profileId} />}
      {view === 'incident' && <IncidentView profileId={profileId} />}
      {view === 'sudoers' && <SudoersView profileId={profileId} />}
      {view === 'ssh' && <SshAccessView profileId={profileId} />}
    </div>
  )
}

function scoreClass(score: number): string {
  if (score >= 80) return 'is-ok'
  if (score >= 60) return 'is-warn'
  return 'is-critical'
}

function severityLabel(severity: string): string {
  return severity.toUpperCase()
}

/**
 * Older audits were persisted before `fixable` existed. FIX_DETAILS contains exactly
 * the findings the backend can remediate, so it also works as a fallback.
 */
function isFixable(finding: SecurityFinding): boolean {
  return finding.fixable === true || finding.id in FIX_DETAILS
}

interface FixDetail {
  what: string
  risk?: string
}

const FIX_DETAILS: Record<string, FixDetail> = {
  'ssh-root-login': {
    what: 'Escribe /etc/ssh/sshd_config.d/00-2shell-permitrootlogin.conf con `PermitRootLogin prohibit-password`, valida con sshd -t y comprueba sshd -T antes de recargar.',
    risk: 'El acceso de root con contraseña deja de funcionar; con clave SSH sigue permitido.',
  },
  'ssh-password-auth': {
    what: 'Escribe el drop-in key-only, valida sshd, verifica que la configuración efectiva ya no permita contraseñas y recarga sshd.',
    risk: 'Quien no tenga una clave autorizada perderá el acceso. Mantén esta sesión abierta y prueba otra terminal.',
  },
  'ssh-empty-passwords': {
    what: 'Añade `PermitEmptyPasswords no` en un drop-in validado de sshd.',
  },
  'ssh-no-pubkey': {
    what: 'Añade `PubkeyAuthentication yes` en un drop-in validado de sshd.',
  },
  'ssh-x11': {
    what: 'Añade `X11Forwarding no` en un drop-in validado de sshd.',
  },
  'ssh-max-auth-tries': {
    what: 'Añade `MaxAuthTries 3` en un drop-in validado de sshd.',
  },
  'ssh-key-perms': {
    what: 'Ajusta propietario y permisos 700/600 en los directorios .ssh y authorized_keys encontrados.',
  },
  'perms-shadow': {
    what: 'Aplica root:root y modo 000 a /etc/shadow.',
    risk: 'Si algún servicio lee /etc/shadow con un usuario distinto de root, dejará de poder hacerlo.',
  },
  'perms-sudoers': {
    what: 'Aplica root:root, modo 440 y valida con visudo -c.',
  },
  'perms-passwd': {
    what: 'Aplica root:root y modo 644 a /etc/passwd.',
  },
  'world-writable-etc': {
    what: 'Quita el bit de escritura para otros en los archivos de /etc que lo tengan y vuelve a comprobarlo en el servidor.',
  },
  'public-db-3306': {
    what: 'Escribe un drop-in con `bind-address = 127.0.0.1`, reinicia MariaDB/MySQL y verifica que el puerto 3306 ya no escucha en 0.0.0.0. Si falla, restaura la configuración y reinicia.',
    risk: 'Si otra máquina se conecta a esta base de datos por red, esa conexión dejará de funcionar. Úsalo solo si la app accede por localhost.',
  },
  'public-db-6379': {
    what: 'Reescribe la directiva `bind` de redis.conf a 127.0.0.1 -::1, reinicia Redis y verifica el puerto. Revierte si falla.',
    risk: 'Los clientes remotos de Redis dejarán de conectar.',
  },
  'suspicious-cron': {
    what: 'Elimina de una vez las entradas marcadas como sospechosas de crontab, /etc/crontab y /etc/cron.d, con un backup por archivo.',
    risk: 'Revisa el listado antes de confirmar: si alguna entrada es legítima, se irá también.',
  },
}

function AuditView({ profileId }: { profileId: string }) {
  const pushToast = useAppStore((state) => state.pushToast)
  const [report, setReport] = useState<SecurityReport | null>(null)
  const [history, setHistory] = useState<SecurityAuditSummary[]>([])
  const [severity, setSeverity] = useState('all')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fixTarget, setFixTarget] = useState<SecurityFinding | null>(null)
  const [fixing, setFixing] = useState(false)
  const [fixError, setFixError] = useState<string | null>(null)
  const [fixOutput, setFixOutput] = useState<string | null>(null)

  const loadHistory = useCallback(async () => {
    try {
      const entries = await securityService.list(profileId, 20)
      setHistory(entries)
      if (entries.length > 0) {
        const latest = await securityService.get(entries[0].id)
        if (latest) setReport(latest)
      }
    } catch (err) {
      setError(String(err))
    }
  }, [profileId])

  useEffect(() => {
    void loadHistory()
  }, [loadHistory])

  const runAudit = async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await securityService.run(profileId)
      setReport(result)
      const entries = await securityService.list(profileId, 20)
      setHistory(entries)
      pushToast(
        'success',
        `Audit completed · score ${result.score}/100 · ${result.findings.length} findings`,
      )
    } catch (err) {
      const message = String(err)
      setError(message)
      pushToast('error', message)
    } finally {
      setLoading(false)
    }
  }

  const applyFix = async () => {
    if (!fixTarget) return
    setFixing(true)
    setFixError(null)
    setFixOutput(null)
    try {
      const result = await securityService.applyFix(profileId, fixTarget.id)
      setFixOutput(result.output)
      if (!result.ok) {
        setFixError(result.output)
        return
      }
      pushToast('success', 'Fix applied · re-running audit')
      setFixTarget(null)
      const refreshed = await securityService.run(profileId)
      setReport(refreshed)
      setHistory(await securityService.list(profileId, 20))
    } catch (err) {
      setFixError(String(err))
    } finally {
      setFixing(false)
    }
  }

  const findings = useMemo(() => {
    if (!report) return []
    return severity === 'all'
      ? report.findings
      : report.findings.filter((finding) => finding.severity === severity)
  }, [report, severity])

  return (
    <div className="security-view">
      <div className="security-toolbar">
        <button className="primary-button" onClick={() => void runAudit()} disabled={loading}>
          <ShieldIcon size={14} /> {loading ? 'Auditing…' : 'Run security audit'}
        </button>
        <button className="top-action" onClick={() => void loadHistory()} disabled={loading}>
          <RefreshIcon size={13} /> Refresh history
        </button>
        {report && (
          <span className="security-meta">
            last run {new Date(report.timestamp * 1000).toLocaleString()} ·{' '}
            {report.durationMs} ms
          </span>
        )}
      </div>

      {error && (
        <div className="inline-alert inline-alert--error">
          <AlertIcon size={15} />
          <span>{error}</span>
        </div>
      )}

      {!report ? (
        <div className="large-files-empty">
          <ShieldIcon size={24} />
          <strong>No security audit yet</strong>
          <p>
            Run an audit to check SSH configuration, firewall, updates, accounts,
            filesystem permissions, exposed database ports, persistence and cron.
          </p>
        </div>
      ) : (
        <>
          <div className="security-summary">
            <div className={`score-card ${scoreClass(report.score)}`}>
              <div className="score-ring" style={{ '--score': report.score } as CSSProperties}>
                <strong>{report.score}</strong>
                <span>/100</span>
              </div>
              <div>
                <span>Security score</span>
                <strong className={scoreClass(report.score)}>
                  {report.score >= 80
                    ? 'Good'
                    : report.score >= 60
                      ? 'Needs attention'
                      : 'Critical'}
                </strong>
                <small>{report.hostname}</small>
              </div>
            </div>
            {(['critical', 'high', 'medium', 'low'] as const).map((level) => (
              <div className={`severity-card sev-${level}`} key={level}>
                <span>{level}</span>
                <strong>{report.summary[level]}</strong>
              </div>
            ))}
            <div className="severity-card sev-passed">
              <span>passed</span>
              <strong>{report.summary.passed}</strong>
            </div>
          </div>

          <div className="audit-history">
            <span>History</span>
            <div className="audit-history__items">
              {history.map((entry) => (
                <button
                  key={entry.id}
                  className={`history-chip ${entry.id === report.id ? 'is-active' : ''}`}
                  onClick={() => {
                    void securityService.get(entry.id).then((value) => value && setReport(value))
                  }}
                  title={`${entry.findings} findings`}
                >
                  <strong>{entry.score}</strong>
                  <span>{new Date(entry.timestamp * 1000).toLocaleDateString()}</span>
                </button>
              ))}
            </div>
          </div>

          <div className="finding-toolbar">
            <h3>Findings</h3>
            <select value={severity} onChange={(event) => setSeverity(event.target.value)}>
              <option value="all">All severities</option>
              <option value="critical">Critical</option>
              <option value="high">High</option>
              <option value="medium">Medium</option>
              <option value="low">Low</option>
              <option value="info">Info</option>
            </select>
          </div>

          <div className="findings-list">
            {findings.map((finding) => (
              <FindingRow
                key={finding.id}
                finding={finding}
                onFix={() => {
                  setFixTarget(finding)
                  setFixError(null)
                  setFixOutput(null)
                }}
              />
            ))}
            {findings.length === 0 && (
              <div className="large-files-empty">
                <CheckIcon size={22} />
                <strong>No findings at this severity</strong>
              </div>
            )}
          </div>

          {fixTarget && (
            <div
              className="modal-backdrop"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget && !fixing) setFixTarget(null)
              }}
            >
              <div className="modal modal--compact" role="dialog" aria-modal="true">
                <header className="modal__header">
                  <div>
                    <h2>Solucionar: {fixTarget.title}</h2>
                    <p>{fixTarget.category} · severidad {fixTarget.severity}</p>
                  </div>
                  <button
                    className="icon-button"
                    onClick={() => setFixTarget(null)}
                    disabled={fixing}
                    title="Cerrar"
                  >
                    <XIcon size={16} />
                  </button>
                </header>
                <div className="modal__body">
                  <div className="fix-step">
                    <span>Qué hará 2Shell</span>
                    <p>{FIX_DETAILS[fixTarget.id]?.what ?? fixTarget.remediation}</p>
                  </div>
                  {(FIX_DETAILS[fixTarget.id]?.risk ?? '') && (
                    <div className="inline-alert inline-alert--error">
                      <AlertIcon size={15} />
                      <span>{FIX_DETAILS[fixTarget.id]?.risk}</span>
                    </div>
                  )}
                  {fixTarget.evidence && (
                    <details className="fix-evidence">
                      <summary>Evidencia detectada</summary>
                      <pre>{fixTarget.evidence}</pre>
                    </details>
                  )}
                  {fixError && (
                    <div className="inline-alert inline-alert--error">
                      <AlertIcon size={15} />
                      <span>{fixError}</span>
                    </div>
                  )}
                  {fixOutput && !fixError && (
                    <pre className="ssh-config-output">{fixOutput}</pre>
                  )}
                </div>
                <footer className="modal__footer">
                  <button
                    className="ghost-button"
                    onClick={() => setFixTarget(null)}
                    disabled={fixing}
                  >
                    Cancelar
                  </button>
                  <button
                    className="primary-button"
                    onClick={() => void applyFix()}
                    disabled={fixing}
                  >
                    <WrenchIcon size={14} /> {fixing ? 'Aplicando…' : 'Aplicar fix'}
                  </button>
                </footer>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

function FindingRow({
  finding,
  onFix,
}: {
  finding: SecurityFinding
  onFix: () => void
}) {
  return (
    <details className={`finding sev-${finding.severity}`}>
      <summary>
        <span className={`severity-badge sev-${finding.severity}`}>
          {severityLabel(finding.severity)}
        </span>
        <strong>{finding.title}</strong>
        <span className="finding-category">{finding.category}</span>
        {isFixable(finding) ? (
          <button
            className="fix-button"
            title="Aplicar la corrección automática"
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              onFix()
            }}
          >
            <WrenchIcon size={12} /> Solucionar
          </button>
        ) : (
          <span className="fix-manual" title="Este hallazgo requiere revisión manual">
            manual
          </span>
        )}
      </summary>
      <div className="finding-body">
        <p>{finding.detail}</p>
        {finding.evidence && <pre>{finding.evidence}</pre>}
        <div className="finding-remediation">
          <span>Remediation</span>
          <p>{finding.remediation}</p>
        </div>
      </div>
    </details>
  )
}

function CronView({ profileId }: { profileId: string }) {
  const pushToast = useAppStore((state) => state.pushToast)
  const [report, setReport] = useState<CronReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<CronEntry | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [backups, setBackups] = useState<CronBackupSummary[]>([])
  const [restoring, setRestoring] = useState<number | null>(null)

  const loadBackups = useCallback(async () => {
    try {
      setBackups(await cronService.listBackups(profileId, 30))
    } catch {
      setBackups([])
    }
  }, [profileId])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setReport(await cronService.list(profileId))
      await loadBackups()
    } catch (err) {
      const message = String(err)
      setError(message)
      pushToast('error', message)
    } finally {
      setLoading(false)
    }
  }, [profileId, pushToast, loadBackups])

  useEffect(() => {
    void load()
  }, [load])

  const canDelete = (entry: CronEntry): boolean =>
    entry.source.startsWith('crontab:') ||
    entry.source === '/etc/crontab' ||
    entry.source.startsWith('/etc/cron.d/')

  const deleteEntry = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    setDeleteError(null)
    try {
      const result = await cronService.deleteEntry(
        profileId,
        deleteTarget.source,
        deleteTarget.raw,
      )
      pushToast(
        'success',
        result.backup
          ? `${result.output} · backup guardado en ${result.backup}`
          : result.output,
      )
      setDeleteTarget(null)
      await load()
    } catch (err) {
      setDeleteError(String(err))
    } finally {
      setDeleting(false)
    }
  }

  const restoreBackup = async (backup: CronBackupSummary) => {
    if (
      !window.confirm(
        `Restaurar ${backup.source} desde ${backup.backupPath}? Se sobrescribe el cron actual.`,
      )
    ) {
      return
    }
    setRestoring(backup.id)
    try {
      const output = await cronService.restoreBackup(backup.id)
      pushToast('success', output)
      await load()
    } catch (err) {
      pushToast('error', String(err))
    } finally {
      setRestoring(null)
    }
  }

  const entries = useMemo(() => {
    if (!report) return []
    const term = search.trim().toLowerCase()
    if (!term) return report.entries
    return report.entries.filter((entry) =>
      [entry.source, entry.schedule, entry.user ?? '', entry.command]
        .join(' ')
        .toLowerCase()
        .includes(term),
    )
  }, [report, search])

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



function SudoersView({ profileId }: { profileId: string }) {
  const pushToast = useAppStore((state) => state.pushToast)
  const [report, setReport] = useState<SudoersReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [target, setTarget] = useState<
    | { kind: 'lock' | 'unlock'; account: SudoAccount }
    | { kind: 'rule'; source: string; raw: string; principal: string }
    | null
  >(null)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setReport(await securityService.sudoers(profileId))
    } catch (err) {
      const message = String(err)
      setError(message)
      pushToast('error', message)
    } finally {
      setLoading(false)
    }
  }, [profileId, pushToast])

  useEffect(() => {
    void load()
  }, [load])

  const apply = async () => {
    if (!target) return
    setBusy(true)
    setActionError(null)
    try {
      const output =
        target.kind === 'rule'
          ? await securityService.removeSudoersRule(profileId, target.source, target.raw)
          : await securityService.setUserLock(
              profileId,
              target.account.user,
              target.kind === 'lock',
            )
      pushToast('success', output)
      setTarget(null)
      await load()
    } catch (err) {
      setActionError(String(err))
    } finally {
      setBusy(false)
    }
  }

  const nopasswd = report?.rules.filter((rule) => rule.nopasswd).length ?? 0
  const privilegedUsers = useMemo(() => {
    if (!report) return []
    const members = new Set<string>()
    report.groups.forEach((group) => group.members.forEach((member) => members.add(member)))
    report.rules.forEach((rule) => members.add(rule.principal))
    return [...members]
  }, [report])

  return (
    <div className="security-view">
      <div className="security-toolbar">
        <button className="primary-button" onClick={() => void load()} disabled={loading}>
          <ShieldIcon size={14} className={loading ? 'spin' : ''} />
          {loading ? 'Leyendo sudoers…' : 'Leer sudoers'}
        </button>
        {report && (
          <>
            <span className={`network-badge ${report.configOk ? 'is-local' : 'is-public'}`}>
              {report.configOk ? <CheckIcon size={11} /> : <AlertIcon size={11} />}
              {report.configOk ? 'visudo -c OK' : 'error de sintaxis'}
            </span>
            <span className="security-meta">
              {report.rules.length} reglas · {nopasswd} con NOPASSWD ·{' '}
              {report.groups.reduce((total, group) => total + group.members.length, 0)} miembros
              en grupos sudo
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
            <div className="inline-alert inline-alert--error">
              <AlertIcon size={15} />
              <span>
                {nopasswd} regla(s) permiten sudo sin contraseña. Revisa que cada una esté
                limitada al comando exacto necesario.
              </span>
            </div>
          )}

          <section className="network-block">
            <header>
              <h3>Grupos con privilegios</h3>
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
                    {!account.exists && <span className="sudoers-orphan">no existe</span>}
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

          <section className="network-block">
            <header>
              <h3>Reglas de sudoers</h3>
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
          </section>

          <div className="sudoers-extras">
            <div>
              <span>Cuentas UID 0</span>
              <strong className="mono">{report.rootAccounts.join(', ') || 'root'}</strong>
            </div>
            {!report.configOk && (
              <pre className="ssh-config-output">{report.configOutput}</pre>
            )}
          </div>
        </>
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

function IncidentView({ profileId }: { profileId: string }) {
  const pushToast = useAppStore((state) => state.pushToast)
  const [scan, setScan] = useState<IncidentScan | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<{
    kind: 'kill' | 'quarantine'
    pid?: number
    path?: string
    title: string
    detail: string
  } | null>(null)
  const [running, setRunning] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [blocked, setBlocked] = useState<string[]>([])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setScan(await incidentService.scan(profileId))
    } catch (err) {
      const message = String(err)
      setError(message)
      pushToast('error', message)
    } finally {
      setLoading(false)
    }
  }, [profileId, pushToast])

  useEffect(() => {
    void load()
  }, [load])

  const apply = async () => {
    if (!confirm) return
    setRunning(true)
    setActionError(null)
    try {
      const result =
        confirm.kind === 'kill'
          ? await incidentService.kill(profileId, confirm.pid ?? 0)
          : await incidentService.quarantine(profileId, confirm.path ?? '')
      if (!result.ok) {
        setActionError(result.output)
        return
      }
      pushToast('success', result.output)
      setConfirm(null)
      await load()
    } catch (err) {
      setActionError(String(err))
    } finally {
      setRunning(false)
    }
  }

  const block = async (ip: string) => {
    try {
      const result = await incidentService.blockIp(profileId, ip, true)
      if (result.ok) {
        setBlocked((current) => [...new Set([...current, ip])])
        pushToast('success', result.output)
      } else {
        pushToast('error', result.output)
      }
    } catch (err) {
      pushToast('error', String(err))
    }
  }

  const askKill = (process: SuspectProcess) =>
    setConfirm({
      kind: 'kill',
      pid: process.pid,
      title: `Matar PID ${process.pid}`,
      detail: `${process.user} · ${process.exe}\n${process.command}`,
    })

  const askQuarantine = (file: SuspectFile) =>
    setConfirm({
      kind: 'quarantine',
      path: file.path,
      title: 'Mover a cuarentena',
      detail: `${file.path} (${file.mode} ${file.owner} ${file.size} bytes)`,
    })

  const counts = {
    processes: scan?.processes.length ?? 0,
    files: scan?.files.length ?? 0,
    connections: scan?.connections.length ?? 0,
    env: scan?.envHits.length ?? 0,
  }

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

function SshAccessView({ profileId }: { profileId: string }) {
  const profiles = useAppStore((state) => state.profiles)
  const profile = profiles.find((item) => item.id === profileId)
  const pushToast = useAppStore((state) => state.pushToast)
  const [keys, setKeys] = useState<SshKey[]>([])
  const [config, setConfig] = useState<SshConfig | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [keyUser, setKeyUser] = useState(profile?.username ?? 'root')
  const [publicKey, setPublicKey] = useState('')
  const [adding, setAdding] = useState(false)
  const [addResult, setAddResult] = useState<string | null>(null)
  const [confirmMode, setConfirmMode] = useState<'disable' | 'enable' | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)
  const [changing, setChanging] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [nextKeys, nextConfig] = await Promise.all([
        sshService.keys(profileId),
        sshService.config(profileId),
      ])
      setKeys(nextKeys)
      setConfig(nextConfig)
    } catch (err) {
      const message = String(err)
      setError(message)
      pushToast('error', message)
    } finally {
      setLoading(false)
    }
  }, [profileId, pushToast])

  useEffect(() => {
    void load()
  }, [load])

  const submitKey = async () => {
    setAdding(true)
    setAddResult(null)
    try {
      const result = await sshService.addKey(profileId, keyUser.trim(), publicKey.trim())
      setAddResult(result.output)
      if (result.ok) {
        pushToast('success', `Key added for ${keyUser}`)
        setPublicKey('')
        await load()
      }
    } catch (err) {
      setAddResult(String(err))
    } finally {
      setAdding(false)
    }
  }

  const removeKey = async (key: SshKey) => {
    if (!window.confirm(`Remove key ${key.fingerprint} from ${key.user}?`)) return
    try {
      const result = await sshService.removeKey(profileId, key.user, key.raw)
      pushToast(result.ok ? 'success' : 'error', result.output)
      if (result.ok) await load()
    } catch (err) {
      pushToast('error', String(err))
    }
  }

  const changeAccess = async () => {
    if (!confirmMode) return
    setChanging(true)
    try {
      const result = await sshService.setKeyOnly(
        profileId,
        confirmMode === 'disable',
        acknowledged,
      )
      pushToast(result.ok ? 'success' : 'error', result.output)
      if (result.config) setConfig(result.config)
      if (result.ok) {
        setConfirmMode(null)
        setAcknowledged(false)
      }
    } catch (err) {
      pushToast('error', String(err))
    } finally {
      setChanging(false)
    }
  }

  const passwordAuth = config?.passwordAuthentication === 'yes'

  return (
    <div className="security-view">
      <div className="security-toolbar">
        <button className="top-action" onClick={() => void load()} disabled={loading}>
          <RefreshIcon size={13} className={loading ? 'spin' : ''} /> Refresh
        </button>
        <button
          className="primary-button"
          onClick={() => {
            setAddResult(null)
            setAddOpen(true)
          }}
        >
          <PlusIcon size={14} /> Add public key
        </button>
        {config && (
          <button
            className={passwordAuth ? 'danger-outline-button' : 'top-action'}
            onClick={() => setConfirmMode(passwordAuth ? 'disable' : 'enable')}
          >
            <KeyIcon size={13} />
            {passwordAuth ? 'Disable password authentication' : 'Restore password authentication'}
          </button>
        )}
        <span className="security-meta">public keys only · no private material stored</span>
      </div>

      {error && (
        <div className="inline-alert inline-alert--error">
          <AlertIcon size={15} />
          <span>{error}</span>
        </div>
      )}

      {config && (
        <>
          <div className="ssh-config-grid">
            <ConfigCard label="Pubkey authentication" value={config.pubkeyAuthentication} />
            <ConfigCard label="Password authentication" value={config.passwordAuthentication} />
            <ConfigCard
              label="Keyboard interactive"
              value={config.kbdInteractiveAuthentication}
            />
            <ConfigCard label="Permit root login" value={config.permitRootLogin} />
            <ConfigCard
              label="sshd -t"
              value={config.configTestOk ? 'valid' : 'failed'}
              good={config.configTestOk}
            />
            <ConfigCard
              label="2Shell drop-in"
              value={config.dropinPresent ? 'present' : 'absent'}
              good={config.dropinPresent}
            />
          </div>
          {!config.configTestOk && config.output && (
            <pre className="ssh-config-output">{config.output}</pre>
          )}
        </>
      )}

      <div className="db-toolbar">
        <h3 className="ssh-section-title">Authorized keys</h3>
        <span className="db-count">{keys.length} keys</span>
      </div>

      <div className="ssh-key-table">
        <div className="ssh-key-row ssh-key-row--head">
          <span>USER</span>
          <span>TYPE / FINGERPRINT</span>
          <span>COMMENT</span>
          <span>ACTIONS</span>
        </div>
        {keys.map((key) => (
          <div className="ssh-key-row" key={`${key.user}-${key.fingerprint}-${key.raw}`}>
            <span className="mono">{key.user}</span>
            <span className="ssh-key-fingerprint">
              <span className="db-plugin">{key.keyType}</span>
              <span className="mono">{key.fingerprint}</span>
            </span>
            <span className="ssh-key-comment" title={key.comment}>
              {key.comment || '—'}
            </span>
            <div className="db-user-actions">
              <button
                className="icon-button is-danger"
                title="Remove key"
                onClick={() => void removeKey(key)}
              >
                <TrashIcon size={14} />
              </button>
            </div>
          </div>
        ))}
        {keys.length === 0 && (
          <div className="large-files-empty">
            <KeyIcon size={22} />
            <strong>No authorized keys found</strong>
            <p>Add a public key before disabling password authentication.</p>
          </div>
        )}
      </div>

      {addOpen && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !adding) setAddOpen(false)
          }}
        >
          <div className="modal modal--compact" role="dialog" aria-modal="true">
            <header className="modal__header">
              <div>
                <h2>Add SSH public key</h2>
                <p>Appends the key to the selected user's authorized_keys.</p>
              </div>
              <button className="icon-button" onClick={() => setAddOpen(false)} title="Close">
                <XIcon size={16} />
              </button>
            </header>
            <div className="modal__body">
              <label className="field">
                <span>System user</span>
                <input
                  value={keyUser}
                  onChange={(event) => setKeyUser(event.target.value)}
                  placeholder="root"
                  spellCheck={false}
                />
              </label>
              <label className="field">
                <span>Public key</span>
                <textarea
                  className="mono-input"
                  rows={5}
                  value={publicKey}
                  onChange={(event) => setPublicKey(event.target.value)}
                  placeholder="ssh-ed25519 AAAA... comment"
                  spellCheck={false}
                />
              </label>
              <p className="field-hint">
                Only public keys. The private key never leaves your workstation.
              </p>
              {addResult && (
                <pre className="ssh-config-output">{addResult}</pre>
              )}
            </div>
            <footer className="modal__footer">
              <button
                className="ghost-button"
                onClick={() => setAddOpen(false)}
                disabled={adding}
              >
                Close
              </button>
              <button
                className="primary-button"
                onClick={() => void submitKey()}
                disabled={adding || !publicKey.trim() || !keyUser.trim()}
              >
                {adding ? 'Adding…' : 'Add key'}
              </button>
            </footer>
          </div>
        </div>
      )}

      {confirmMode && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !changing) setConfirmMode(null)
          }}
        >
          <div className="modal modal--compact" role="dialog" aria-modal="true">
            <header className="modal__header">
              <div>
                <h2>
                  {confirmMode === 'disable'
                    ? 'Disable password authentication'
                    : 'Restore password authentication'}
                </h2>
                <p>
                  {confirmMode === 'disable'
                    ? 'This changes sshd to key-only access.'
                    : 'This removes the 2Shell key-only drop-in.'}
                </p>
              </div>
              <button className="icon-button" onClick={() => setConfirmMode(null)} title="Close">
                <XIcon size={16} />
              </button>
            </header>
            <div className="modal__body">
              <div className="inline-alert inline-alert--error">
                <AlertIcon size={15} />
                <span>
                  Keep this SSH session open. Before closing it, open a new terminal and
                  verify that you can log in with your SSH key. If the key fails, you can
                  still revert from this session.
                </span>
              </div>
              <p className="field-hint">
                2Shell writes a drop-in at <code>/etc/ssh/sshd_config.d/00-2shell-key-only.conf</code>,
                runs <code>sshd -t</code>, verifies the effective configuration and reloads
                sshd. It refuses to disable passwords if no authorized keys exist.
              </p>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={acknowledged}
                  onChange={(event) => setAcknowledged(event.target.checked)}
                />
                I have a working SSH key and will test a new session before closing this one.
              </label>
            </div>
            <footer className="modal__footer">
              <button
                className="ghost-button"
                onClick={() => setConfirmMode(null)}
                disabled={changing}
              >
                Cancel
              </button>
              <button
                className={confirmMode === 'disable' ? 'danger-button' : 'primary-button'}
                onClick={() => void changeAccess()}
                disabled={changing || !acknowledged}
              >
                {changing
                  ? 'Applying…'
                  : confirmMode === 'disable'
                    ? 'Disable password auth'
                    : 'Restore password auth'}
              </button>
            </footer>
          </div>
        </div>
      )}
    </div>
  )
}

function ConfigCard({
  label,
  value,
  good,
}: {
  label: string
  value: string
  good?: boolean
}) {
  return (
    <div className="db-info-card">
      <span>{label}</span>
      <strong className={good === undefined ? '' : good ? 'is-ok' : 'is-critical'}>
        {value}
      </strong>
    </div>
  )
}
