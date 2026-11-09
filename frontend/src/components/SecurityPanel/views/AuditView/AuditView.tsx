import {
  AlertIcon,
  CheckIcon,
  ChevronRightIcon,
  CopyIcon,
  InfoIcon,
  RefreshIcon,
  ShieldIcon,
  TerminalIcon,
  WrenchIcon,
  XIcon,
} from '@/components/Icons'
import { securityService } from '@/services/security.service'
import type { SecurityFinding } from '@/types'
import { useState, type CSSProperties } from 'react'

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
    what: 'Writes /etc/ssh/sshd_config.d/00-2shell-permitrootlogin.conf with `PermitRootLogin prohibit-password`, validates with sshd -t, and checks sshd -T before reloading.',
    risk: 'Password-based root login will no longer work; SSH key authentication remains allowed.',
  },
  'ssh-password-auth': {
    what: 'Writes the key-only drop-in, validates sshd, verifies effective config no longer permits passwords, and reloads sshd.',
    risk: 'Anyone without an authorized public key will lose access. Keep this active session open and verify with another terminal before disconnecting.',
  },
  'ssh-empty-passwords': {
    what: 'Adds `PermitEmptyPasswords no` in a validated sshd drop-in.',
  },
  'ssh-no-pubkey': {
    what: 'Adds `PubkeyAuthentication yes` in a validated sshd drop-in.',
  },
  'ssh-x11': {
    what: 'Adds `X11Forwarding no` in a validated sshd drop-in.',
  },
  'ssh-max-auth-tries': {
    what: 'Adds `MaxAuthTries 3` in a validated sshd drop-in.',
  },
  'ssh-key-perms': {
    what: 'Sets ownership and strict 700/600 permissions on discovered .ssh directories and authorized_keys files.',
  },
  'perms-shadow': {
    what: 'Applies root:root ownership and 000 mode to /etc/shadow.',
    risk: 'Any service reading /etc/shadow as a non-root user will no longer be able to access it.',
  },
  'perms-sudoers': {
    what: 'Applies root:root ownership, 440 mode, and validates with visudo -c.',
  },
  'perms-passwd': {
    what: 'Applies root:root ownership and 644 mode to /etc/passwd.',
  },
  'world-writable-etc': {
    what: 'Removes the write bit for others (chmod o-w) from affected files in /etc and verifies on the server.',
  },
  'public-db-3306': {
    what: 'Writes a drop-in with `bind-address = 127.0.0.1`, restarts MariaDB/MySQL, and verifies port 3306 is no longer listening on 0.0.0.0. Restores configuration on failure.',
    risk: 'External network connections to this database port will be blocked. Use only if application services connect via localhost.',
  },
  'public-db-6379': {
    what: 'Rewrites bind directive in redis.conf to 127.0.0.1 -::1, restarts Redis, and verifies port. Reverts on failure.',
    risk: 'Remote Redis clients will no longer be able to connect.',
  },
  'suspicious-cron': {
    what: 'Removes entries flagged as suspicious from crontab, /etc/crontab, and /etc/cron.d, creating a backup per file.',
    risk: 'Review list before confirming; legitimate entries matching suspicious patterns will also be deleted.',
  },
}

interface CommandGuide {
  command: string
  purpose: string
  why: string
}

function getRemediationCommandGuide(finding: SecurityFinding): CommandGuide | null {
  const id = finding.id.toLowerCase()
  const text = `${finding.title} ${finding.detail} ${finding.remediation}`.toLowerCase()

  if (id.includes('sshd-config') || text.includes('sshd -t')) {
    return {
      command: 'sshd -t',
      purpose: 'Validates OpenSSH daemon configuration syntax and file accessibility without terminating active processes.',
      why: 'Catches syntax errors or bad directives in /etc/ssh/sshd_config and drop-in files prior to reloading, preventing administrator lockout and SSH service failure.',
    }
  }

  if (id === 'ssh-root-login' || text.includes('permitrootlogin')) {
    return {
      command: 'PermitRootLogin prohibit-password',
      purpose: 'Restricts direct root authentication over SSH strictly to public key credentials, rejecting passwords for root.',
      why: 'Eliminates brute-force attacks against the root account while enforcing accountability and sudo-based privilege escalation.',
    }
  }

  if (id === 'ssh-password-auth' || text.includes('passwordauthentication')) {
    return {
      command: 'PasswordAuthentication no',
      purpose: 'Enforces cryptographic key authentication and disables password prompts in sshd.',
      why: 'Prevents credential stuffing, dictionary attacks, and password spraying, reducing brute-force exposure to zero.',
    }
  }

  if (id === 'ssh-empty-passwords' || text.includes('permitemptypasswords')) {
    return {
      command: 'PermitEmptyPasswords no',
      purpose: 'Prevents sshd from accepting authentication for accounts with empty or blank passwords.',
      why: 'Guarantees that unconfigured or rogue local system accounts cannot be exploited without valid credentials.',
    }
  }

  if (id === 'ssh-no-pubkey' || text.includes('pubkeyauthentication')) {
    return {
      command: 'PubkeyAuthentication yes',
      purpose: 'Enables asymmetric public key authentication in sshd.',
      why: 'Allows secure, passphrase-protected SSH key authentication, which is the industry standard for server administration.',
    }
  }

  if (id === 'ssh-x11' || text.includes('x11forwarding')) {
    return {
      command: 'X11Forwarding no',
      purpose: 'Disables X11 graphical display forwarding across SSH sessions.',
      why: 'Reduces attack surface; untrusted remote X11 clients could snoop on keystrokes or local X server displays.',
    }
  }

  if (id === 'ssh-max-auth-tries' || text.includes('maxauthtries')) {
    return {
      command: 'MaxAuthTries 3',
      purpose: 'Caps the maximum number of failed authentication attempts allowed per SSH connection.',
      why: 'Thwarts automated dictionary attacks by terminating rogue sessions early before extensive guessing can occur.',
    }
  }

  if (id.includes('perms-sudoers') || text.includes('visudo')) {
    return {
      command: 'visudo -c && chmod 440 /etc/sudoers',
      purpose: 'Performs syntax validation on /etc/sudoers and enforces secure 0440 permissions.',
      why: 'Prevents sudoers file corruption that would lock administrators out of root execution, while enforcing strict ownership security.',
    }
  }

  if (id.includes('perms-shadow') || text.includes('shadow')) {
    return {
      command: 'chmod 000 /etc/shadow && chown root:root /etc/shadow',
      purpose: 'Applies mode 000 and root:root ownership to the system password hash store.',
      why: 'Ensures that unprivileged local users and non-root services cannot read salted cryptographic hashes for offline cracking.',
    }
  }

  if (id.includes('perms-passwd') || text.includes('/etc/passwd')) {
    return {
      command: 'chmod 644 /etc/passwd && chown root:root /etc/passwd',
      purpose: 'Sets readable mode 644 and root ownership on /etc/passwd.',
      why: 'Allows system tools to resolve UIDs and usernames while strictly prohibiting unprivileged modification of accounts.',
    }
  }

  if (id.includes('ssh-key-perms') || text.includes('authorized_keys')) {
    return {
      command: 'chmod 700 ~/.ssh && chmod 600 ~/.ssh/authorized_keys',
      purpose: 'Restricts permissions on SSH keys so only the account owner has read/write privileges.',
      why: 'OpenSSH StrictModes ignores authorized_keys files if group or other users have write access, causing key auth failures.',
    }
  }

  if (id.includes('public-db') || text.includes('bind-address')) {
    return {
      command: 'bind-address = 127.0.0.1',
      purpose: 'Configures database daemons to listen exclusively on the local loopback interface.',
      why: 'Blocks public internet exposure of internal database ports (e.g. 3306, 6379), preventing remote port scans and direct attacks.',
    }
  }

  if (id.includes('suspicious-cron') || text.includes('cron')) {
    return {
      command: 'crontab -r',
      purpose: 'Removes unverified or suspicious automated scheduled cron jobs.',
      why: 'Terminates unauthorized persistence mechanisms such as reverse shells, crypto miners, or scheduled downloader scripts.',
    }
  }

  // Generic fallback if remediation contains a backticked or quoted command
  const backtickMatch = finding.remediation.match(/[`']([^`']+)['`]/)
  if (backtickMatch) {
    return {
      command: backtickMatch[1],
      purpose: 'Executes the recommended diagnostic or remediation command.',
      why: 'Validates configuration parameters and applies security hardening to mitigate the identified risk.',
    }
  }

  return null
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
                    <h2>Remediate: {fixTarget.title}</h2>
                    <p>{fixTarget.category} · severity {fixTarget.severity}</p>
                  </div>
                  <button
                    className="icon-button"
                    onClick={() => setFixTarget(null)}
                    disabled={fixing}
                    title="Close"
                  >
                    <XIcon size={16} />
                  </button>
                </header>
                <div className="modal__body">
                  <div className="fix-step">
                    <span>What 2Shell will do</span>
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
                      <summary>Detected evidence</summary>
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
                    Cancel
                  </button>
                  <button
                    className="primary-button"
                    onClick={() => void applyFix()}
                    disabled={fixing}
                  >
                    <WrenchIcon size={14} /> {fixing ? 'Remediating…' : 'Apply remediation'}
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
  const [showGuide, setShowGuide] = useState(false)
  const guide = getRemediationCommandGuide(finding)

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
            title="Apply automated remediation"
            onClick={(event) => {
              event.preventDefault()
              event.stopPropagation()
              onFix()
            }}
          >
            <WrenchIcon size={12} /> Fix
          </button>
        ) : (
          <span className="fix-manual" title="This finding requires manual review">
            manual
          </span>
        )}
        <span className="finding-chevron">
          <ChevronRightIcon size={13} />
        </span>
      </summary>
      <div className="finding-body">
        <p className="finding-detail">{finding.detail}</p>
        {finding.evidence && (
          <div className="finding-evidence-block">
            <div className="finding-evidence-header">
              <span className="finding-evidence-tag">
                <TerminalIcon size={11} /> Detected evidence
              </span>
              <button
                type="button"
                className="finding-evidence-copy"
                title="Copy evidence"
                onClick={(event) => {
                  event.preventDefault()
                  event.stopPropagation()
                  void navigator.clipboard.writeText(finding.evidence)
                }}
              >
                <CopyIcon size={11} /> Copy
              </button>
            </div>
            <pre>{finding.evidence}</pre>
          </div>
        )}
        <div className="finding-remediation">
          <div className="finding-remediation-header">
            <span>
              <CheckIcon size={12} /> Recommended remediation
            </span>
            {guide && (
              <div className="remediation-tooltip-wrapper">
                <button
                  type="button"
                  className={`remediation-guide-pill ${showGuide ? 'is-active' : ''}`}
                  title="Click to view what this command does and why it is recommended"
                  onClick={(event) => {
                    event.preventDefault()
                    event.stopPropagation()
                    setShowGuide((v) => !v)
                  }}
                >
                  <InfoIcon size={11} />
                  <span>Command Guide</span>
                </button>
                {showGuide && (
                  <div
                    className="remediation-guide-popover"
                    onClick={(event) => {
                      event.preventDefault()
                      event.stopPropagation()
                    }}
                  >
                    <div className="remediation-guide-popover__header">
                      <div className="remediation-guide-popover__title">
                        <TerminalIcon size={12} />
                        <code>{guide.command}</code>
                      </div>
                      <button
                        type="button"
                        className="remediation-guide-popover__close"
                        title="Close tooltip"
                        onClick={(event) => {
                          event.preventDefault()
                          event.stopPropagation()
                          setShowGuide(false)
                        }}
                      >
                        <XIcon size={11} />
                      </button>
                    </div>
                    <div className="remediation-guide-popover__content">
                      <div className="remediation-guide-field">
                        <span className="remediation-guide-label">WHAT IT DOES (PURPOSE)</span>
                        <p>{guide.purpose}</p>
                      </div>
                      <div className="remediation-guide-field">
                        <span className="remediation-guide-label">WHY IT IS RECOMMENDED</span>
                        <p>{guide.why}</p>
                      </div>
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
          <p>{finding.remediation}</p>
        </div>
      </div>
    </details>
  )
}
