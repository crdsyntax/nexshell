import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/store/useAppStore'
import { databaseService } from '@/services/database.service'
import {
  AlertIcon,
  CheckIcon,
  DatabaseIcon,
  EyeIcon,
  EyeOffIcon,
  KeyIcon,
  RefreshIcon,
  SearchIcon,
  ShieldIcon,
  XIcon,
} from '@/components/Icons'
import type { DbInfo, DbPasswordResult, DbUser } from '@/types'

interface DatabasePanelProps {
  profileId: string
}

function generatePassword(): string {
  const bytes = new Uint8Array(24)
  crypto.getRandomValues(bytes)
  return Array.from(bytes, (value) => value.toString(16).padStart(2, '0')).join('')
}

function defaultTestHost(host: string): string {
  return host === 'localhost' ? 'localhost' : '127.0.0.1'
}

export function DatabasePanel({ profileId }: DatabasePanelProps) {
  const profiles = useAppStore((state) => state.profiles)
  const pushToast = useAppStore((state) => state.pushToast)
  const profile = profiles.find((item) => item.id === profileId)

  const [info, setInfo] = useState<DbInfo | null>(null)
  const [users, setUsers] = useState<DbUser[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  const [passwordTarget, setPasswordTarget] = useState<DbUser | null>(null)
  const [password, setPassword] = useState('')
  const [showPassword, setShowPassword] = useState(false)
  const [testConnection, setTestConnection] = useState(true)
  const [testHost, setTestHost] = useState('127.0.0.1')
  const [testPort, setTestPort] = useState('3306')
  const [testDatabase, setTestDatabase] = useState('')
  const [changing, setChanging] = useState(false)
  const [changeResult, setChangeResult] = useState<DbPasswordResult | null>(null)
  const [changeError, setChangeError] = useState<string | null>(null)

  const [grantsTarget, setGrantsTarget] = useState<DbUser | null>(null)
  const [grants, setGrants] = useState<string | null>(null)
  const [grantsLoading, setGrantsLoading] = useState(false)
  const [grantsError, setGrantsError] = useState<string | null>(null)

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [dbInfo, dbUsers] = await Promise.all([
        databaseService.info(profileId),
        databaseService.users(profileId),
      ])
      setInfo(dbInfo)
      setUsers(dbUsers)
    } catch (err) {
      const message = String(err)
      setError(message)
      try {
        setInfo(await databaseService.info(profileId))
      } catch {
        setInfo(null)
      }
    } finally {
      setLoading(false)
    }
  }, [profileId])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const filteredUsers = useMemo(() => {
    const term = search.trim().toLowerCase()
    if (!term) return users
    return users.filter((user) =>
      [user.user, user.host, user.plugin].join(' ').toLowerCase().includes(term),
    )
  }, [users, search])

  const openPasswordModal = (user: DbUser) => {
    setPasswordTarget(user)
    setPassword(generatePassword())
    setShowPassword(true)
    setTestConnection(true)
    setTestHost(defaultTestHost(user.host))
    setTestPort('3306')
    setTestDatabase('')
    setChangeResult(null)
    setChangeError(null)
  }

  const closePasswordModal = () => {
    setPasswordTarget(null)
    setPassword('')
    setChangeResult(null)
    setChangeError(null)
  }

  const submitPassword = async () => {
    if (!passwordTarget) return
    if (password.length < 8) {
      setChangeError('The new password must be at least 8 characters.')
      return
    }
    setChanging(true)
    setChangeError(null)
    setChangeResult(null)
    try {
      const result = await databaseService.changePassword(
        profileId,
        passwordTarget.user,
        passwordTarget.host,
        password,
        testConnection ? testHost : '',
        Number(testPort) || 3306,
        testConnection ? testDatabase : '',
      )
      setChangeResult(result)
      if (result.ok) {
        pushToast('success', `Password changed for ${passwordTarget.user}@${passwordTarget.host}`)
      } else {
        pushToast('error', 'Password change failed')
      }
    } catch (err) {
      const message = String(err)
      setChangeError(message)
      pushToast('error', message)
    } finally {
      setChanging(false)
    }
  }

  const openGrants = async (user: DbUser) => {
    setGrantsTarget(user)
    setGrants(null)
    setGrantsError(null)
    setGrantsLoading(true)
    try {
      setGrants(await databaseService.grants(profileId, user.user, user.host))
    } catch (err) {
      setGrantsError(String(err))
    } finally {
      setGrantsLoading(false)
    }
  }

  return (
    <div className="panel db-panel">
      <div className="panel__header">
        <div>
          <div className="panel__eyebrow">
            <DatabaseIcon size={14} /> database control
          </div>
          <h2>
            Databases
            <span className="panel__sub">{profile?.name ?? profileId}</span>
          </h2>
          <p className="panel__description">
            MariaDB / MySQL users, credentials and grants over the existing SSH session.
          </p>
        </div>
        <div className="panel__actions">
          <button className="top-action" onClick={() => void refresh()} disabled={loading}>
            <RefreshIcon size={14} className={loading ? 'spin' : ''} />
            {loading ? 'Loading…' : 'Refresh'}
          </button>
        </div>
      </div>

      {error && (
        <div className="inline-alert inline-alert--error">
          <AlertIcon size={15} />
          <span>{error}</span>
        </div>
      )}

      {info && (
        <div className="db-info-grid">
          <div className="db-info-card">
            <span>Engine</span>
            <strong>{info.version || 'not reachable'}</strong>
          </div>
          <div className="db-info-card">
            <span>Service</span>
            <strong className={info.serviceState === 'active' ? 'is-ok' : ''}>
              {info.serviceState}
            </strong>
          </div>
          <div className="db-info-card">
            <span>Host / port</span>
            <strong className="mono">
              {info.hostname || '—'}:{info.port}
            </strong>
          </div>
          <div className="db-info-card">
            <span>Socket</span>
            <strong className="mono">{info.socket || '—'}</strong>
          </div>
        </div>
      )}

      {info && !info.canQuery && (
        <div className="inline-alert">
          <AlertIcon size={15} />
          <span>
            Cannot query <code>mysql.user</code>. {info.error ?? ''} Use an SSH root
            profile, or enable elevated mode with passwordless sudo for the MariaDB
            client.
          </span>
        </div>
      )}

      <div className="db-toolbar">
        <div className="db-search">
          <SearchIcon size={14} />
          <input
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            placeholder="Filter users, hosts or plugins…"
            spellCheck={false}
          />
        </div>
        <span className="db-count">{filteredUsers.length} users</span>
      </div>

      {loading ? (
        <div className="large-files-loading">
          <span className="spinner" /> Reading database accounts…
        </div>
      ) : filteredUsers.length === 0 ? (
        <div className="large-files-empty">
          <DatabaseIcon size={22} />
          <strong>No database users returned</strong>
          <p>
            The client may not be installed, or the SSH user cannot authenticate to
            MariaDB. Check the error above.
          </p>
        </div>
      ) : (
        <div className="db-user-table">
          <div className="db-user-row db-user-row--head">
            <span>USER</span>
            <span>HOST</span>
            <span>PLUGIN</span>
            <span>ACTIONS</span>
          </div>
          {filteredUsers.map((user) => (
            <div className="db-user-row" key={`${user.user}@${user.host}`}>
              <span className="db-user-name">
                {user.user}
                {user.system && <span className="db-system-badge">system</span>}
              </span>
              <span className="mono">{user.host}</span>
              <span className="db-plugin">{user.plugin || '—'}</span>
              <div className="db-user-actions">
                <button
                  className="icon-button"
                  title="Change password"
                  onClick={() => openPasswordModal(user)}
                >
                  <KeyIcon size={14} />
                </button>
                <button
                  className="icon-button"
                  title="Show grants"
                  onClick={() => void openGrants(user)}
                >
                  <ShieldIcon size={14} />
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      {passwordTarget && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !changing) closePasswordModal()
          }}
        >
          <div className="modal modal--compact" role="dialog" aria-modal="true">
            <header className="modal__header">
              <div>
                <h2>Change database password</h2>
                <p className="mono">
                  {passwordTarget.user}@{passwordTarget.host}
                </p>
              </div>
              <button
                className="icon-button"
                onClick={closePasswordModal}
                disabled={changing}
                title="Close"
              >
                <XIcon size={16} />
              </button>
            </header>
            <div className="modal__body">
              {passwordTarget.user === 'root' &&
                passwordTarget.plugin === 'unix_socket' && (
                  <div className="inline-alert">
                    <AlertIcon size={15} />
                    <span>
                      This root account uses <code>unix_socket</code>. Setting a password
                      may switch its authentication plugin and disable passwordless
                      <code> sudo mysql</code>. Keep your current MariaDB session open and
                      test before closing it.
                    </span>
                  </div>
                )}

              <label className="field">
                <span>New password</span>
                <div className="input-with-action db-password-input">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    autoComplete="new-password"
                    spellCheck={false}
                  />
                  <button
                    className="icon-button"
                    type="button"
                    onClick={() => setShowPassword((value) => !value)}
                    title={showPassword ? 'Hide password' : 'Show password'}
                  >
                    {showPassword ? <EyeOffIcon size={15} /> : <EyeIcon size={15} />}
                  </button>
                </div>
              </label>
              <div className="db-password-tools">
                <button
                  className="text-button"
                  onClick={() => {
                    setPassword(generatePassword())
                    setShowPassword(true)
                  }}
                >
                  Generate strong password
                </button>
                <span>{password.length} chars · avoid reusing it</span>
              </div>

              <label className="check-row db-test-toggle">
                <input
                  type="checkbox"
                  checked={testConnection}
                  onChange={(event) => setTestConnection(event.target.checked)}
                />
                Test the new credentials after changing the password
              </label>

              {testConnection && (
                <div className="form-grid db-test-grid">
                  <label className="field">
                    <span>Test host</span>
                    <input
                      value={testHost}
                      onChange={(event) => setTestHost(event.target.value)}
                      spellCheck={false}
                    />
                  </label>
                  <label className="field">
                    <span>Port</span>
                    <input
                      value={testPort}
                      onChange={(event) => setTestPort(event.target.value.replace(/\D/g, ''))}
                      inputMode="numeric"
                    />
                  </label>
                  <label className="field field--wide">
                    <span>Database <em>optional</em></span>
                    <input
                      value={testDatabase}
                      onChange={(event) => setTestDatabase(event.target.value)}
                      placeholder="app_database"
                      spellCheck={false}
                    />
                  </label>
                </div>
              )}

              <p className="field-hint">
                After changing the application user's password, update its
                <code> .env</code> or PM2 environment and restart the process.
              </p>

              {changeError && (
                <div className="inline-alert inline-alert--error">
                  <AlertIcon size={15} />
                  <span>{changeError}</span>
                </div>
              )}

              {changeResult && (
                <div
                  className={`command-result ${
                    changeResult.ok ? 'command-result--ok' : 'command-result--error'
                  }`}
                >
                  <div className="command-result__head">
                    {changeResult.ok ? <CheckIcon size={14} /> : <AlertIcon size={14} />}
                    <strong>{changeResult.ok ? 'Password changed' : 'Change failed'}</strong>
                    <span>exit {changeResult.exitCode}</span>
                  </div>
                  <pre>{changeResult.output}</pre>
                  {changeResult.test && (
                    <div className="db-login-test">
                      {changeResult.test.ok ? (
                        <CheckIcon size={14} />
                      ) : (
                        <AlertIcon size={14} />
                      )}
                      <span>
                        {changeResult.test.ok
                          ? 'Login test with the new password succeeded.'
                          : `Login test failed: ${changeResult.test.error ?? changeResult.test.output}`}
                      </span>
                    </div>
                  )}
                </div>
              )}
            </div>
            <footer className="modal__footer">
              <button className="ghost-button" onClick={closePasswordModal} disabled={changing}>
                Close
              </button>
              <button
                className="primary-button"
                onClick={() => void submitPassword()}
                disabled={changing || password.length < 8}
              >
                {changing ? 'Changing…' : 'Change password'}
              </button>
            </footer>
          </div>
        </div>
      )}

      {grantsTarget && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setGrantsTarget(null)
          }}
        >
          <div className="modal modal--compact" role="dialog" aria-modal="true">
            <header className="modal__header">
              <div>
                <h2>Grants</h2>
                <p className="mono">
                  {grantsTarget.user}@{grantsTarget.host}
                </p>
              </div>
              <button className="icon-button" onClick={() => setGrantsTarget(null)} title="Close">
                <XIcon size={16} />
              </button>
            </header>
            <div className="modal__body">
              {grantsLoading && (
                <div className="large-files-loading">
                  <span className="spinner" /> Reading grants…
                </div>
              )}
              {grantsError && (
                <div className="inline-alert inline-alert--error">
                  <AlertIcon size={15} />
                  <span>{grantsError}</span>
                </div>
              )}
              {grants && <pre className="db-grants">{grants}</pre>}
            </div>
            <footer className="modal__footer">
              <button className="ghost-button" onClick={() => setGrantsTarget(null)}>
                Close
              </button>
            </footer>
          </div>
        </div>
      )}
    </div>
  )
}
