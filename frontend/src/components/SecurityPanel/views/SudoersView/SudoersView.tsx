import {
  AlertIcon,
  CheckIcon,
  KeyIcon,
  RefreshIcon,
  SearchIcon,
  ShieldIcon,
  TrashIcon,
  XIcon,
} from '@/components/Icons'

import { useSudoersView } from './useSudoersView'
import { useAppStore } from '@/store/useAppStore'

export function SudoersView({ profileId }: { profileId: string }) {
  const profiles = useAppStore((state) => state.profiles)
  const pushToast = useAppStore((state) => state.pushToast)
  const profile = profiles.find((item) => item.id === profileId)

  const {
    actionError,
    apply,
    busy,
    error,
    load,
    loading,
    nopasswd,
    openOrigin,
    origin,
    originError,
    originLoading,
    originUser,
    privilegedUsers,
    report,
    setActionError,
    setOrigin,
    setOriginUser,
    setTarget,
    target,
  } = useSudoersView(profileId)

  const isPermissionDenied = Boolean(
    report &&
      !report.configOk &&
      (report.configOutput.toLowerCase().includes('permission denied') ||
        report.configOutput.toLowerCase().includes('unable to open /etc/sudoers') ||
        report.configOutput.toLowerCase().includes('a password is required')),
  )

  return (
    <div className="security-view">
      <div className="sec-toolbar">
        <button className="primary-button" onClick={() => void load()} disabled={loading}>
          <RefreshIcon size={13} className={loading ? 'spin' : ''} />
          {loading ? 'Reading sudoers…' : 'Read sudoers'}
        </button>
        {report && (
          <>
            <span className={`sec-status ${report.configOk ? 'is-ok' : 'is-bad'}`}>
              {report.configOk ? <CheckIcon size={12} /> : <AlertIcon size={12} />}
              visudo -c: {report.configOk ? 'syntax valid' : 'errors'}
            </span>
            <div className="forensics-stats">
              <span className="forensics-stat-pill">
                <strong>{report.rules.length}</strong> active rules
              </span>
              <span className={`forensics-stat-pill ${nopasswd > 0 ? 'is-warning' : ''}`}>
                <strong>{nopasswd}</strong> passwordless
              </span>
              <span className="forensics-stat-pill">
                <strong>{report.accounts.length}</strong> accounts
              </span>
            </div>
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
          {isPermissionDenied && (
            <div className="sudoers-permission-alert">
              <div className="sudoers-permission-alert__icon">
                <AlertIcon size={20} />
              </div>
              <div className="sudoers-permission-alert__body">
                <h4>Insufficient permissions to audit sudoers</h4>
                <p>
                  The current SSH session user (<strong>{profile?.username || 'user'}</strong>) lacks superuser (root/sudo) privileges to read <code>/etc/sudoers</code>.
                </p>
                <div className="sudoers-permission-alert__details mono">
                  {report.configOutput}
                </div>
                <div className="sudoers-permission-alert__solutions">
                  <strong>How to view sudoers rules and privileged accounts:</strong>
                  <ol>
                    <li>
                      <strong>Connect as root:</strong> Log in or update the connection profile to authenticate directly as the <code>root</code> user.
                    </li>
                    <li>
                      <strong>Enable profile elevation:</strong> If the user <code>{profile?.username || 'current'}</code> has sudo privileges on the server, edit the connection profile and enable <em>"Use sudo -n for service actions"</em>.
                    </li>
                    <li>
                      <strong>Grant read permissions on the host:</strong> If you administer the host, add this user to the <code>wheel</code> group or add a NOPASSWD audit drop-in rule:
                      <div className="command-result__copy-snippet" style={{ marginTop: 6 }}>
                        <code>
                          {`echo "${profile?.username || 'user'} ALL=(ALL) NOPASSWD: /usr/sbin/visudo, /bin/cat /etc/sudoers, /bin/cat /etc/sudoers.d/*" | sudo tee /etc/sudoers.d/2shell-audit`}
                        </code>
                        <button
                          type="button"
                          className="ghost-button ghost-button--xs"
                          onClick={() => {
                            navigator.clipboard.writeText(
                              `echo "${profile?.username || 'user'} ALL=(ALL) NOPASSWD: /usr/sbin/visudo, /bin/cat /etc/sudoers, /bin/cat /etc/sudoers.d/*" | sudo tee /etc/sudoers.d/2shell-audit`,
                            )
                            pushToast('success', 'Audit rule copied to clipboard')
                          }}
                        >
                          Copy rule
                        </button>
                      </div>
                    </li>
                  </ol>
                </div>
              </div>
            </div>
          )}

          {nopasswd > 0 && (
            <div className="risk-banner">
              <span className="risk-banner__icon">
                <AlertIcon size={16} />
              </span>
              <div className="risk-banner__body">
                <strong>
                  Critical exposure: {nopasswd} rule{nopasswd === 1 ? '' : 's'} allow passwordless sudo
                </strong>
                <p>
                  Verify that each rule is scoped to the exact required command binary. A
                  NOPASSWD: ALL rule provides unrestricted root escalation.
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
                Inspect risk
              </button>
            </div>
          )}

          <div className="sudoers-grid">
            <div className="sudoers-col">
              <section className="network-block">
                <header>
                  <h3>
                    <ShieldIcon size={13} /> Privileged groups
                  </h3>
                  <span>{privilegedUsers.length} users</span>
                </header>
                <div className="sudoers-table">
                  <div className="sudoers-row sudoers-row--head">
                    <span>GROUP</span>
                    <span>GID</span>
                    <span>MEMBERS</span>
                  </div>
                  {report.groups.map((group) => (
                    <div className="sudoers-row" key={group.name}>
                      <span className="mono sudoers-principal-group">{group.name}</span>
                      <span className="mono">{group.gid}</span>
                      <span className="mono sudoers-members">
                        {group.members.length > 0 ? group.members.join(', ') : '—'}
                      </span>
                    </div>
                  ))}
                  {report.groups.length === 0 && (
                    <div className="process-table__empty">
                      No wheel/sudo/admin groups found.
                    </div>
                  )}
                </div>
              </section>

              <section className="network-block">
                <header>
                  <h3>
                    <ShieldIcon size={13} /> Referenced accounts
                  </h3>
                  <span>{report.accounts.length}</span>
                </header>
                <div className="sudoers-table sudoers-table--accounts">
                  <div className="sudoers-row sudoers-row--head">
                    <span>USER</span>
                    <span>UID</span>
                    <span>SHELL</span>
                    <span>KEYS</span>
                    <span style={{ textAlign: 'right' }}>ACTIONS</span>
                  </div>
                  {report.accounts.map((account) => (
                    <div className="sudoers-row" key={account.user}>
                      <span className="mono sudoers-user" title={account.home || account.user}>
                        <span className={account.user === 'root' ? 'sudoers-principal-root' : ''}>
                          {account.user}
                        </span>
                        {!account.exists ? (
                          <span className="sudoers-orphan">NOT FOUND</span>
                        ) : (
                          <span
                            className={`sudoers-state ${
                              account.passwordStatus === 'L' ? 'is-locked' : 'is-active'
                            }`}
                          >
                            {account.passwordStatus === 'L' ? 'LOCKED' : 'ACTIVE'}
                          </span>
                        )}
                      </span>
                      <span className="mono">{account.uid || '—'}</span>
                      <span className="mono sudoers-ellipsis" title={account.shell}>
                        {account.shell || '—'}
                      </span>
                      <span className="mono">
                        <KeyIcon size={11} style={{ verticalAlign: 'middle', marginRight: 4 }} />
                        {account.authorizedKeys}
                      </span>
                      <span className="sudoers-account-actions">
                        <button
                          className="sudoers-origin-btn"
                          title="View account creation source, originating IP, and timestamps"
                          onClick={() => void openOrigin(account.user)}
                          disabled={busy}
                        >
                          <SearchIcon size={11} /> Origin
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
                            {account.passwordStatus === 'L' ? 'Unlock' : 'Lock'}
                          </button>
                        )}
                      </span>
                    </div>
                  ))}
                  {report.accounts.length === 0 && (
                    <div className="process-table__empty">
                      {isPermissionDenied
                        ? 'Unable to resolve sudoers accounts: root/sudo privileges required.'
                        : 'No referenced accounts.'}
                    </div>
                  )}
                </div>
              </section>
            </div>

            <div className="sudoers-col sudoers-rules">
              <section className="network-block">
                <header>
                  <h3>
                    <ShieldIcon size={13} /> Sudoers rules (/etc/sudoers)
                  </h3>
                  <span>{report.rules.length}</span>
                </header>
                <div className="sudoers-table sudoers-table--rules">
                  <div className="sudoers-row sudoers-row--head">
                    <span>USER</span>
                    <span>HOST</span>
                    <span>RUNAS</span>
                    <span>COMMANDS</span>
                    <span>SOURCE</span>
                    <span style={{ textAlign: 'right' }}>ACTIONS</span>
                  </div>
                  {report.rules.map((rule, index) => (
                    <div className="sudoers-row" key={`${rule.source}-${rule.principal}-${index}`}>
                      <span className="mono sudoers-user">
                        {rule.principal.startsWith('%') ? (
                          <span className="sudoers-principal-group">{rule.principal}</span>
                        ) : rule.principal === 'root' ? (
                          <span className="sudoers-principal-root">{rule.principal}</span>
                        ) : (
                          <span>{rule.principal}</span>
                        )}
                        {rule.nopasswd && <span className="sudoers-badge">NOPASSWD</span>}
                      </span>
                      <span className="mono">{rule.host}</span>
                      <span className="mono">{rule.runas || '—'}</span>
                      <span
                        className={`mono sudoers-commands ${
                          rule.commands.includes('NOPASSWD') || rule.nopasswd
                            ? 'sudoers-badge'
                            : ''
                        }`}
                        title={rule.commands}
                        style={
                          rule.commands.includes('NOPASSWD') || rule.nopasswd
                            ? { background: 'transparent', border: 'none', padding: 0 }
                            : undefined
                        }
                      >
                        {rule.commands}
                      </span>
                      <span className="mono sudoers-source" title={rule.source}>
                        {rule.source}
                      </span>
                      <span className="sudoers-account-actions">
                        <button
                          className="icon-button is-danger"
                          title="Delete this rule (with backup and visudo -c)"
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
                    <div className="process-table__empty">
                      {isPermissionDenied
                        ? 'Unable to read rules: permission denied on /etc/sudoers.'
                        : 'No explicit rules.'}
                    </div>
                  )}
                </div>
                <div className="sudoers-ledger">
                  <span>
                    <ShieldIcon size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />
                    UID 0 accounts: <strong>{report.rootAccounts.join(', ') || 'root'}</strong>
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
                  Account origin · {originUser}
                  <span className="panel__sub">{profileId}</span>
                </h2>
                <p>auditd, /var/log/secure, sudo, last, and filesystem metadata.</p>
              </div>
              <button
                className="icon-button"
                onClick={() => {
                  setOriginUser(null)
                  setOrigin(null)
                }}
                disabled={originLoading}
                title="Close"
              >
                <XIcon size={16} />
              </button>
            </header>
            <div className="modal__body pm2-logs-body">
              {originLoading && <div className="process-table__empty">tracing origin…</div>}
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
                      <span>Created</span>
                      <strong className="mono">{origin.createdAt || 'unknown'}</strong>
                    </div>
                    <div>
                      <span>Created by</span>
                      <strong className="mono">{origin.createdBy || 'unknown'}</strong>
                    </div>
                    <div>
                      <span>Source IP</span>
                      <strong className="mono">{origin.sourceIp || 'unknown'}</strong>
                    </div>
                    <div>
                      <span>Home</span>
                      <strong className="mono">
                        {origin.homeBirth || origin.homeChange || '—'}
                      </strong>
                    </div>
                    <div>
                      <span>Group</span>
                      <strong className="mono">{origin.group || '—'}</strong>
                    </div>
                    <div>
                      <span>auditd</span>
                      <strong className="mono">
                        {origin.auditAvailable ? 'logged' : 'no audit records'}
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
                    <h4>Creation events</h4>
                    {origin.evidence.length === 0 ? (
                      <p className="process-table__empty">
                        No creation evidence found in available logs.
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
                    <h4>Login sessions ({origin.logins.length})</h4>
                    <pre className="pm2-log-pre origin-pre">
                      {origin.logins.join('\n') || 'no entries in last'}
                    </pre>
                  </div>

                  {origin.sshLog.length > 0 && (
                    <details className="origin-section">
                      <summary>Root SSH access ({origin.sshLog.length})</summary>
                      <pre className="pm2-log-pre origin-pre">{origin.sshLog.join('\n')}</pre>
                    </details>
                  )}

                  {origin.history.length > 0 && (
                    <details className="origin-section">
                      <summary>Root shell history ({origin.history.length})</summary>
                      <pre className="pm2-log-pre origin-pre">{origin.history.join('\n')}</pre>
                    </details>
                  )}
                </>
              )}
            </div>
            <footer className="modal__footer">
              <span className="field-hint">
                auditd is the authoritative source; without auditd, ephemeral logs may have rotated or purged.
              </span>
              <button
                className="ghost-button"
                onClick={() => {
                  setOriginUser(null)
                  setOrigin(null)
                }}
              >
                Close
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
                    ? 'Remove sudoers rule'
                    : target.kind === 'lock'
                      ? `Lock account · ${target.account.user}`
                      : `Unlock account · ${target.account.user}`}
                </h2>
                <p>
                  {target.kind === 'rule'
                    ? 'A timestamped backup will be created and validated with visudo -c.'
                    : 'The account retains all files; only the shadow password status is modified.'}
                </p>
              </div>
              <button
                className="icon-button"
                onClick={() => setTarget(null)}
                disabled={busy}
                title="Close"
              >
                <XIcon size={16} />
              </button>
            </header>
            <div className="modal__body">
              {target.kind === 'rule' ? (
                <>
                  <div className="process-summary">
                    <div>
                      <span>Principal</span>
                      <strong className="mono">{target.principal}</strong>
                    </div>
                    <div>
                      <span>Source</span>
                      <strong className="mono">{target.source}</strong>
                    </div>
                    <code>{target.raw}</code>
                  </div>
                  <div className="inline-alert inline-alert--error">
                    <AlertIcon size={15} />
                    <span>
                      If this is the only rule in the drop-in file, the file will be removed. Backups
                      are saved to /var/backups/2shell/sudoers.
                    </span>
                  </div>
                </>
              ) : (
                <div className="process-summary">
                  <div>
                    <span>Account</span>
                    <strong className="mono">{target.account.user}</strong>
                  </div>
                  <div>
                    <span>UID</span>
                    <strong className="mono">{target.account.uid || '—'}</strong>
                  </div>
                  <div>
                    <span>SSH keys</span>
                    <strong className="mono">{target.account.authorizedKeys}</strong>
                  </div>
                  <div>
                    <span>Last login</span>
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
                Cancel
              </button>
              <button
                className={target.kind === 'rule' ? 'danger-button' : 'primary-button'}
                onClick={() => void apply()}
                disabled={busy}
              >
                {busy
                  ? 'Applying…'
                  : target.kind === 'rule'
                    ? 'Remove rule'
                    : target.kind === 'lock'
                      ? 'Lock account'
                      : 'Unlock account'}
              </button>
            </footer>
          </div>
        </div>
      )}
    </div>
  )
}
