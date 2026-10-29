import { useEffect, useMemo, useRef, useState } from 'react'
import { open as openFileDialog } from '@tauri-apps/plugin-dialog'
import { profileService } from '@/services/profile.service'
import { useAppStore } from '@/store/useAppStore'
import {
  AlertIcon,
  CheckIcon,
  EyeIcon,
  EyeOffIcon,
  FolderIcon,
  KeyIcon,
  RefreshIcon,
  ShieldIcon,
  XIcon,
} from '@/components/Icons'
import type { AuthMethod, KeyProbe, Profile, ProfileInput, TestResult } from '@/types'

interface ConnectionModalProps {
  open: boolean
  profile: Profile | null
  onClose: () => void
  onSaved: () => void
}

interface FormState {
  name: string
  host: string
  port: string
  username: string
  authMethod: AuthMethod
  password: string
  privateKey: string
  passphrase: string
  keyPath: string
  keySource: 'stored' | 'path' | 'inline'
  color: string
  environment: string
  tags: string
  elevated: boolean
  retryMaxRetries: string
  retryBaseDelayMs: string
  retryMaxDelayMs: string
  retryJitter: boolean
  poolMaxConnections: string
  poolAcquireTimeoutMs: string
  poolIdleTimeoutSecs: string
  keepaliveSecs: string
  connectTimeoutSecs: string
}

const COLORS = ['#f97316', '#fbbf24', '#a3e635', '#a3e635', '#ef4444', '#fca5a5', '#9ba1ad']

const DEFAULTS: FormState = {
  name: '',
  host: '',
  port: '22',
  username: 'root',
  authMethod: 'password',
  password: '',
  privateKey: '',
  passphrase: '',
  keyPath: '',
  keySource: 'stored',
  color: '#f97316',
  environment: 'development',
  tags: '',
  elevated: false,
  retryMaxRetries: '3',
  retryBaseDelayMs: '400',
  retryMaxDelayMs: '8000',
  retryJitter: true,
  poolMaxConnections: '4',
  poolAcquireTimeoutMs: '10000',
  poolIdleTimeoutSecs: '300',
  keepaliveSecs: '20',
  connectTimeoutSecs: '12',
}

function fromProfile(profile: Profile | null): FormState {
  if (!profile) return { ...DEFAULTS }
  return {
    name: profile.name,
    host: profile.host,
    port: String(profile.port),
    username: profile.username,
    authMethod: profile.authMethod,
    password: '',
    privateKey: '',
    passphrase: '',
    keyPath: profile.keyPath ?? '',
    keySource: 'stored',
    color: profile.color,
    environment: profile.environment,
    tags: profile.tags.join(', '),
    elevated: profile.elevated,
    retryMaxRetries: String(profile.retry.maxRetries),
    retryBaseDelayMs: String(profile.retry.baseDelayMs),
    retryMaxDelayMs: String(profile.retry.maxDelayMs),
    retryJitter: profile.retry.jitter,
    poolMaxConnections: String(profile.pool.maxConnections),
    poolAcquireTimeoutMs: String(profile.pool.acquireTimeoutMs),
    poolIdleTimeoutSecs: String(profile.pool.idleTimeoutSecs),
    keepaliveSecs: String(profile.keepaliveSecs),
    connectTimeoutSecs: String(profile.connectTimeoutSecs),
  }
}

function toNumber(value: string, fallback: number): number {
  const parsed = Number(value)
  return Number.isFinite(parsed) ? parsed : fallback
}

export function ConnectionModal({ open, profile, onClose, onSaved }: ConnectionModalProps) {
  const [form, setForm] = useState<FormState>(DEFAULTS)
  const [showPassword, setShowPassword] = useState(false)
  const [showKey, setShowKey] = useState(false)
  const [advanced, setAdvanced] = useState(false)
  const [testing, setTesting] = useState(false)
  const [saving, setSaving] = useState(false)
  const [testResult, setTestResult] = useState<TestResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [keyProbe, setKeyProbe] = useState<KeyProbe | null>(null)
  const passphraseRef = useRef<HTMLInputElement>(null)
  const pushToast = useAppStore((state) => state.pushToast)

  useEffect(() => {
    if (!open) return
    setForm(fromProfile(profile))
    setShowPassword(false)
    setShowKey(false)
    setAdvanced(false)
    setTestResult(null)
    setError(null)
    setTesting(false)
    setSaving(false)
    setKeyProbe(null)
  }, [open, profile])

  const title = profile ? `Edit ${profile.name}` : 'New connection'
  const subtitle = profile
    ? 'Credentials left blank keep their stored values.'
    : 'SSH profile with pooling, retries and encrypted credentials.'

  const input = useMemo<ProfileInput>(
    () => ({
      id: profile?.id ?? '',
      name: form.name.trim(),
      host: form.host.trim(),
      port: toNumber(form.port, 22),
      username: form.username.trim(),
      authMethod: form.authMethod,
      password: form.password || null,
      privateKey: form.privateKey || null,
      passphrase: form.passphrase || null,
      keyPath: form.keyPath || null,
      clearPrivateKey: form.keySource === 'path',
      clearKeyPath: form.keySource === 'inline',
      color: form.color,
      environment: form.environment,
      tags: form.tags
        .split(',')
        .map((tag) => tag.trim())
        .filter(Boolean),
      retry: {
        maxRetries: toNumber(form.retryMaxRetries, 3),
        baseDelayMs: toNumber(form.retryBaseDelayMs, 400),
        maxDelayMs: toNumber(form.retryMaxDelayMs, 8000),
        jitter: form.retryJitter,
      },
      pool: {
        maxConnections: toNumber(form.poolMaxConnections, 4),
        acquireTimeoutMs: toNumber(form.poolAcquireTimeoutMs, 10000),
        idleTimeoutSecs: toNumber(form.poolIdleTimeoutSecs, 300),
      },
      keepaliveSecs: toNumber(form.keepaliveSecs, 20),
      connectTimeoutSecs: toNumber(form.connectTimeoutSecs, 12),
      elevated: form.elevated,
    }),
    [form, profile?.id],
  )

  if (!open) return null

  const update = <K extends keyof FormState>(key: K, value: FormState[K]) => {
    setForm((current) => ({ ...current, [key]: value }))
  }

  const inspectKey = async (path: string) => {
    try {
      const probe = await profileService.probeKey(path)
      setKeyProbe(probe)
      if (probe.encrypted) {
        window.setTimeout(() => passphraseRef.current?.focus(), 60)
      }
      return probe
    } catch (err) {
      setKeyProbe({
        path,
        exists: false,
        encrypted: false,
        valid: false,
        error: String(err),
      })
      return null
    }
  }

  const browseKeyFile = async () => {
    try {
      const selected = await openFileDialog({
        multiple: false,
        directory: false,
        title: 'Select SSH private key',
      })
      if (typeof selected === 'string') {
        setForm((current) => ({
          ...current,
          keyPath: selected,
          privateKey: '',
          keySource: 'path',
          authMethod: 'key',
        }))
        setShowKey(false)
        setError(null)
        await inspectKey(selected)
      }
    } catch (err) {
      setError(`Could not open the file dialog: ${String(err)}`)
    }
  }

  const validate = (): string | null => {
    if (!input.host) return 'Host is required.'
    if (!input.username) return 'Username is required.'
    if (input.port < 1 || input.port > 65535) return 'Port must be between 1 and 65535.'
    if (input.pool.maxConnections < 1 || input.pool.maxConnections > 32) {
      return 'Pool size must be between 1 and 32.'
    }
    if (input.retry.maxDelayMs < input.retry.baseDelayMs) {
      return 'Retry max delay must be greater than or equal to the base delay.'
    }
    if (input.authMethod === 'password' && !input.password && !profile?.hasPassword) {
      return 'Enter a password for this connection.'
    }
    if (input.authMethod === 'key' && !input.privateKey && !input.keyPath && !profile?.hasPrivateKey) {
      return 'Provide a private key, a key path, or keep an existing stored key.'
    }
    if (
      input.authMethod === 'key' &&
      keyProbe?.encrypted &&
      !input.passphrase &&
      !profile?.hasPassphrase
    ) {
      return 'This private key is encrypted. Enter its passphrase in the Key passphrase field.'
    }
    if (input.authMethod === 'key' && keyProbe && !keyProbe.exists) {
      return `The selected key file does not exist: ${keyProbe.path}`
    }
    return null
  }

  const handleTest = async () => {
    const validation = validate()
    if (validation) {
      setError(validation)
      return
    }
    setError(null)
    setTesting(true)
    setTestResult(null)
    try {
      const result = await profileService.test(input)
      setTestResult(result)
    } catch (err) {
      setTestResult({ ok: false, latencyMs: 0, server: null, error: String(err) })
    } finally {
      setTesting(false)
    }
  }

  const handleSave = async () => {
    const validation = validate()
    if (validation) {
      setError(validation)
      return
    }
    setError(null)
    setSaving(true)
    try {
      await profileService.save(input)
      pushToast('success', profile ? 'Connection updated' : 'Connection created')
      onSaved()
    } catch (err) {
      setError(String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div className="modal" role="dialog" aria-modal="true">
        <header className="modal__header">
          <div>
            <h2>{title}</h2>
            <p>{subtitle}</p>
          </div>
          <button className="icon-button" onClick={onClose} title="Close">
            <XIcon size={16} />
          </button>
        </header>

        <div className="modal__body">
          <div className="form-grid">
            <label className="field field--wide">
              <span>Display name</span>
              <input
                value={form.name}
                onChange={(event) => update('name', event.target.value)}
                placeholder="production-web-01"
                spellCheck={false}
              />
            </label>

            <label className="field field--host">
              <span>Host</span>
              <input
                value={form.host}
                onChange={(event) => update('host', event.target.value)}
                onBlur={() => {
                  if (!form.name && form.host) {
                    update('name', `${form.username}@${form.host}`)
                  }
                }}
                placeholder="10.0.0.12 or server.example.com"
                spellCheck={false}
              />
            </label>

            <label className="field field--port">
              <span>Port</span>
              <input
                value={form.port}
                onChange={(event) => update('port', event.target.value.replace(/\D/g, ''))}
                inputMode="numeric"
              />
            </label>

            <label className="field">
              <span>Username</span>
              <input
                value={form.username}
                onChange={(event) => update('username', event.target.value)}
                placeholder="root"
                spellCheck={false}
              />
            </label>

            <label className="field">
              <span>Environment</span>
              <select
                value={form.environment}
                onChange={(event) => update('environment', event.target.value)}
              >
                <option value="development">development</option>
                <option value="staging">staging</option>
                <option value="production">production</option>
              </select>
            </label>

            <label className="field field--wide">
              <span>Tags <em>comma separated</em></span>
              <input
                value={form.tags}
                onChange={(event) => update('tags', event.target.value)}
                placeholder="web, eu-west, critical"
                spellCheck={false}
              />
            </label>
          </div>

          <div className="auth-section">
            <div className="auth-tabs">
              <button
                className={form.authMethod === 'password' ? 'is-active' : ''}
                onClick={() => update('authMethod', 'password')}
                type="button"
              >
                <ShieldIcon size={14} /> Password
              </button>
              <button
                className={form.authMethod === 'key' ? 'is-active' : ''}
                onClick={() => update('authMethod', 'key')}
                type="button"
              >
                <KeyIcon size={14} /> Private key
              </button>
            </div>

            {form.authMethod === 'password' ? (
              <label className="field">
                <span>
                  Password{' '}
                  {profile?.hasPassword && <em>stored — leave blank to keep</em>}
                </span>
                <div className="input-with-action">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={form.password}
                    onChange={(event) => update('password', event.target.value)}
                    placeholder={profile?.hasPassword ? '••••••••' : 'SSH password'}
                    autoComplete="off"
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
            ) : (
              <div className="key-fields">
                <div className="field field--wide">
                  <span>
                    Local key path{' '}
                    {profile?.hasPrivateKey && <em>stored key available</em>}
                  </span>
                  <div className="input-with-action input-with-action--browse">
                    <input
                      value={form.keyPath}
                      onChange={(event) => {
                        const value = event.target.value
                        setForm((current) => ({
                          ...current,
                          keyPath: value,
                          privateKey: value ? '' : current.privateKey,
                          keySource: value ? 'path' : 'stored',
                        }))
                        if (value) setKeyProbe(null)
                      }}
                      onBlur={(event) => {
                        const value = event.target.value.trim()
                        if (value) void inspectKey(value)
                        else setKeyProbe(null)
                      }}
                      placeholder="~/.ssh/id_ed25519"
                      spellCheck={false}
                      aria-label="SSH private key path"
                    />
                    <button
                      type="button"
                      className="browse-button"
                      onClick={() => void browseKeyFile()}
                      title="Open the file picker"
                    >
                      <FolderIcon size={14} /> Browse…
                    </button>
                  </div>
                  <p className="field-hint">
                    Opens the native file picker. The path is stored; the key contents are
                    not copied.
                  </p>
                  {keyProbe?.encrypted && (
                    <div className="inline-alert inline-alert--warn">
                      <AlertIcon size={14} />
                      <span>
                        This key is encrypted. Enter its passphrase below; it will be stored
                        encrypted with the profile.
                      </span>
                    </div>
                  )}
                  {keyProbe && !keyProbe.exists && (
                    <div className="inline-alert inline-alert--error">
                      <AlertIcon size={14} />
                      <span>Key file not found: {keyProbe.path}</span>
                    </div>
                  )}
                  {keyProbe && keyProbe.exists && !keyProbe.encrypted && keyProbe.error && (
                    <div className="inline-alert inline-alert--error">
                      <AlertIcon size={14} />
                      <span>Cannot read this key: {keyProbe.error}</span>
                    </div>
                  )}
                  {keyProbe?.valid && (
                    <div className="inline-alert inline-alert--ok">
                      <CheckIcon size={14} />
                      <span>Private key detected and readable.</span>
                    </div>
                  )}
                </div>
                <label className="field field--wide">
                  <span>Or paste the private key</span>
                  <textarea
                    className="mono-input"
                    rows={4}
                    value={showKey ? form.privateKey : form.privateKey ? '••••••••••••••••' : ''}
                    onChange={(event) => {
                      const value = event.target.value
                      setForm((current) => ({
                        ...current,
                        privateKey: value,
                        keyPath: value ? '' : current.keyPath,
                        keySource: value ? 'inline' : 'stored',
                      }))
                      if (value) {
                        setKeyProbe(null)
                        setShowKey(true)
                      }
                    }}
                    onFocus={() => setShowKey(true)}
                    placeholder="-----BEGIN OPENSSH PRIVATE KEY-----"
                    spellCheck={false}
                  />
                </label>
                <label className="field field--wide">
                  <span>Key passphrase</span>
                  <input
                    ref={passphraseRef}
                    type="password"
                    value={form.passphrase}
                    onChange={(event) => update('passphrase', event.target.value)}
                    placeholder={
                      profile?.hasPassphrase
                        ? 'stored — leave blank to keep'
                        : keyProbe?.encrypted
                          ? 'required for this encrypted key'
                          : 'optional'
                    }
                    autoComplete="off"
                  />
                </label>
              </div>
            )}
          </div>

          <div className="color-row">
            <span className="color-row__label">Accent</span>
            {COLORS.map((color) => (
              <button
                key={color}
                className={`color-swatch ${form.color === color ? 'is-active' : ''}`}
                style={{ background: color }}
                onClick={() => update('color', color)}
                title={color}
                type="button"
              />
            ))}
          </div>

          <button
            className="advanced-toggle"
            onClick={() => setAdvanced((value) => !value)}
            type="button"
          >
            <span className={`chevron ${advanced ? 'is-open' : ''}`}>›</span>
            Pooling, retries and timeouts
            <span className="advanced-toggle__summary">
              {form.poolMaxConnections} conns · {form.retryMaxRetries} retries ·{' '}
              {form.keepaliveSecs}s keepalive
            </span>
          </button>

          {advanced && (
            <div className="advanced-grid">
              <fieldset>
                <legend>Retry policy</legend>
                <label className="field">
                  <span>Max retries</span>
                  <input
                    value={form.retryMaxRetries}
                    onChange={(event) => update('retryMaxRetries', event.target.value.replace(/\D/g, ''))}
                    inputMode="numeric"
                  />
                </label>
                <label className="field">
                  <span>Base delay (ms)</span>
                  <input
                    value={form.retryBaseDelayMs}
                    onChange={(event) => update('retryBaseDelayMs', event.target.value.replace(/\D/g, ''))}
                    inputMode="numeric"
                  />
                </label>
                <label className="field">
                  <span>Max delay (ms)</span>
                  <input
                    value={form.retryMaxDelayMs}
                    onChange={(event) => update('retryMaxDelayMs', event.target.value.replace(/\D/g, ''))}
                    inputMode="numeric"
                  />
                </label>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={form.retryJitter}
                    onChange={(event) => update('retryJitter', event.target.checked)}
                  />
                  Add jitter to backoff
                </label>
              </fieldset>

              <fieldset>
                <legend>Connection pool</legend>
                <label className="field">
                  <span>Max connections</span>
                  <input
                    value={form.poolMaxConnections}
                    onChange={(event) => update('poolMaxConnections', event.target.value.replace(/\D/g, ''))}
                    inputMode="numeric"
                  />
                </label>
                <label className="field">
                  <span>Acquire timeout (ms)</span>
                  <input
                    value={form.poolAcquireTimeoutMs}
                    onChange={(event) => update('poolAcquireTimeoutMs', event.target.value.replace(/\D/g, ''))}
                    inputMode="numeric"
                  />
                </label>
                <label className="field">
                  <span>Idle timeout (s)</span>
                  <input
                    value={form.poolIdleTimeoutSecs}
                    onChange={(event) => update('poolIdleTimeoutSecs', event.target.value.replace(/\D/g, ''))}
                    inputMode="numeric"
                  />
                </label>
              </fieldset>

              <fieldset>
                <legend>Timeouts</legend>
                <label className="field">
                  <span>Connect timeout (s)</span>
                  <input
                    value={form.connectTimeoutSecs}
                    onChange={(event) => update('connectTimeoutSecs', event.target.value.replace(/\D/g, ''))}
                    inputMode="numeric"
                  />
                </label>
                <label className="field">
                  <span>Keepalive (s)</span>
                  <input
                    value={form.keepaliveSecs}
                    onChange={(event) => update('keepaliveSecs', event.target.value.replace(/\D/g, ''))}
                    inputMode="numeric"
                  />
                </label>
              </fieldset>

              <fieldset>
                <legend>Privileges</legend>
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={form.elevated}
                    onChange={(event) => update('elevated', event.target.checked)}
                  />
                  Use <code>sudo -n</code> for service actions
                </label>
                <p className="field-hint">
                  Requires passwordless sudo (NOPASSWD) on the remote host for
                  systemctl and config writes.
                </p>
              </fieldset>
            </div>
          )}

          {error && (
            <div className="inline-alert inline-alert--error">
              <AlertIcon size={15} />
              <span>{error}</span>
            </div>
          )}

          {testResult && (
            <div
              className={`test-result ${
                testResult.ok ? 'test-result--ok' : 'test-result--error'
              }`}
            >
              <div className="test-result__head">
                {testResult.ok ? <CheckIcon size={15} /> : <AlertIcon size={15} />}
                <strong>
                  {testResult.ok ? 'Connection established' : 'Connection failed'}
                </strong>
                <span className="test-result__latency">{testResult.latencyMs} ms</span>
              </div>
              {testResult.error && <p>{testResult.error}</p>}
              {testResult.server && (
                <div className="test-result__grid">
                  <span>Host</span>
                  <strong>{testResult.server.hostname}</strong>
                  <span>OS</span>
                  <strong>{testResult.server.osName}</strong>
                  <span>Kernel</span>
                  <strong>{testResult.server.kernel}</strong>
                  <span>Init</span>
                  <strong>{testResult.server.initSystem}</strong>
                  <span>CPU / RAM</span>
                  <strong>
                    {testResult.server.cpuCount} vCPU ·{' '}
                    {Math.round(testResult.server.memTotalKb / 1024)} MiB
                  </strong>
                  <span>Fingerprint</span>
                  <strong className="mono">{testResult.server.fingerprint}</strong>
                  <span>Web servers</span>
                  <strong>
                    {testResult.server.webServers.length === 0
                      ? 'none detected'
                      : testResult.server.webServers
                          .map((server) => `${server.name}${server.active ? ' (active)' : ''}`)
                          .join(', ')}
                  </strong>
                </div>
              )}
            </div>
          )}
        </div>

        <footer className="modal__footer">
          <button className="ghost-button" onClick={onClose} disabled={saving}>
            Cancel
          </button>
          <div className="modal__footer-right">
            <button className="top-action" onClick={handleTest} disabled={testing || saving}>
              <RefreshIcon size={14} className={testing ? 'spin' : ''} />
              {testing ? 'Testing…' : 'Test connection'}
            </button>
            <button className="primary-button" onClick={handleSave} disabled={saving || testing}>
              {saving ? 'Saving…' : profile ? 'Save changes' : 'Create connection'}
            </button>
          </div>
        </footer>
      </div>
    </div>
  )
}
