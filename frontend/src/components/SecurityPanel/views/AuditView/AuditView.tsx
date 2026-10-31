import { AlertIcon, CheckIcon, ChevronRightIcon, RefreshIcon, ShieldIcon, WrenchIcon, XIcon } from '@/components/Icons'
import { securityService } from '@/services/security.service'
import type { SecurityFinding } from '@/types'
import type { CSSProperties } from 'react'

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


function scoreLabel(score: number): string {
  if (score >= 80) return 'GOOD'
  if (score >= 60) return 'NEEDS ATTENTION'
  if (score >= 40) return 'WARNING'
  return 'CRITICAL'
}

import { useAuditView } from './useAuditView'

export function AuditView({ profileId }: { profileId: string }) {
  const { applyFix, error, findings, fixError, fixOutput, fixTarget, fixing, history, loadHistory, loading, report, runAudit, setFixError, setFixOutput, setFixTarget, setReport, setSeverity, severity } = useAuditView(profileId)


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
                  {scoreLabel(report.score)}
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
            <h3>
              FINDINGS <span className="findings-count">{findings.length} AUDIT ITEMS</span>
            </h3>
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
        <span className="finding-chevron">
          <ChevronRightIcon size={13} />
        </span>
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
