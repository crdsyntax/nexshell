import {
  AlertIcon,
  CheckIcon,
  CopyIcon,
  KeyIcon,
  PlusIcon,
  RefreshIcon,
  ShieldIcon,
  TerminalIcon,
  TrashIcon,
  XIcon,
} from '@/components/Icons'
import type { SshKey } from '@/types'
import { useState } from 'react'

import { useSshAccessView } from './useSshAccessView'

export function SshAccessView({ profileId }: { profileId: string }) {
  const {
    acknowledged,
    addOpen,
    addResult,
    adding,
    changeAccess,
    changing,
    config,
    confirmMode,
    error,
    keyUser,
    keys,
    load,
    loading,
    passwordAuth,
    publicKey,
    removeKey,
    setAcknowledged,
    setAddOpen,
    setAddResult,
    setConfirmMode,
    setKeyUser,
    setPublicKey,
    submitKey,
  } = useSshAccessView(profileId)

  const [copiedFingerprint, setCopiedFingerprint] = useState<string | null>(null)

  const handleCopyFingerprint = async (key: SshKey) => {
    try {
      await navigator.clipboard.writeText(key.fingerprint)
      setCopiedFingerprint(key.fingerprint)
      setTimeout(() => setCopiedFingerprint(null), 2000)
    } catch {
      // ignore
    }
  }

  return (
    <div className="security-view">
      <div className="security-toolbar">
        <button className="top-action" onClick={() => void load()} disabled={loading}>
          <RefreshIcon size={13} className={loading ? 'spin' : ''} />
          {loading ? 'Leyendo política…' : 'Refresh'}
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
        <span className="security-meta">
          <ShieldIcon size={12} style={{ verticalAlign: 'middle', marginRight: 4 }} />
          public keys only · no private material stored
        </span>
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

      <div className="ssh-header-bar">
        <h3 className="ssh-section-title">
          <KeyIcon size={15} /> Authorized keys
        </h3>
        <div className="forensics-stats">
          <span className="forensics-stat-pill">
            <strong>{keys.length}</strong> {keys.length === 1 ? 'clave' : 'claves'}
          </span>
        </div>
      </div>

      <div className="ssh-key-table">
        <div className="ssh-key-row ssh-key-row--head">
          <span>USER</span>
          <span>TYPE / FINGERPRINT</span>
          <span>COMMENT</span>
          <span style={{ textAlign: 'right' }}>ACTIONS</span>
        </div>
        {keys.map((key) => {
          const isEd25519 = key.keyType.toLowerCase().includes('ed25519')
          const isRsa = key.keyType.toLowerCase().includes('rsa')
          const isEmail = key.comment.includes('@')
          const isCopied = copiedFingerprint === key.fingerprint

          return (
            <div className="ssh-key-row" key={`${key.user}-${key.fingerprint}-${key.raw}`}>
              <span
                className={`mono ssh-user-tag ${key.user === 'root' ? 'is-root' : ''}`}
                title={key.path || key.user}
              >
                <KeyIcon size={12} style={{ color: 'var(--muted-2)' }} />
                {key.user}
              </span>
              <div className="ssh-key-fingerprint-cell">
                <div className="ssh-key-fingerprint-line">
                  <span
                    className={`ssh-algo-badge ${
                      isEd25519 ? 'is-ed25519' : isRsa ? 'is-rsa' : ''
                    }`}
                  >
                    {isEd25519 ? 'ED25519' : isRsa ? 'RSA' : key.keyType}
                  </span>
                  <span className="mono ssh-fingerprint-text" title={key.fingerprint}>
                    {key.fingerprint}
                  </span>
                  <button
                    className="ssh-copy-btn"
                    onClick={() => void handleCopyFingerprint(key)}
                    title={isCopied ? '¡Copiado!' : 'Copiar huella digital (SHA256)'}
                  >
                    {isCopied ? (
                      <CheckIcon size={12} style={{ color: 'var(--ok)' }} />
                    ) : (
                      <CopyIcon size={12} />
                    )}
                  </button>
                </div>
              </div>
              <span
                className={`ssh-key-comment-cell ${isEmail ? 'is-email' : ''}`}
                title={key.comment}
              >
                {key.comment || '—'}
              </span>
              <div className="db-user-actions" style={{ justifyContent: 'flex-end' }}>
                <button
                  className="icon-button is-danger"
                  title="Remove key"
                  onClick={() => void removeKey(key)}
                >
                  <TrashIcon size={14} />
                </button>
              </div>
            </div>
          )
        })}
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
              {addResult && <pre className="ssh-config-output">{addResult}</pre>}
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

function getPolicyConfig(label: string, value: string, good?: boolean) {
  const normalized = value.toLowerCase().trim()
  if (label === 'Pubkey authentication') {
    const isYes = normalized === 'yes'
    return {
      icon: <KeyIcon size={14} />,
      badgeClass: isYes ? 'is-secure' : 'is-danger',
      badgeText: isYes ? 'Habilitada' : 'Deshabilitada',
      sub: 'Criptografía asimétrica',
    }
  }
  if (label === 'Password authentication') {
    const isNo = normalized === 'no'
    return {
      icon: <ShieldIcon size={14} />,
      badgeClass: isNo ? 'is-secure' : 'is-warning',
      badgeText: isNo ? 'Bloqueada (segura)' : 'Permitida (vulnerable)',
      sub: 'Protección fuerza bruta',
    }
  }
  if (label === 'Keyboard interactive') {
    const isNo = normalized === 'no'
    return {
      icon: <TerminalIcon size={14} />,
      badgeClass: isNo ? 'is-secure' : 'is-warning',
      badgeText: isNo ? 'Desactivada' : 'Activa',
      sub: 'Desafío / respuesta PAM',
    }
  }
  if (label === 'Permit root login') {
    const isKeyOnly = normalized === 'without-password' || normalized === 'prohibit-password'
    const isNo = normalized === 'no'
    return {
      icon: <ShieldIcon size={14} />,
      badgeClass: isKeyOnly ? 'is-info' : isNo ? 'is-secure' : 'is-danger',
      badgeText: isKeyOnly ? 'Solo con clave' : isNo ? 'Denegado' : 'Sin restricción',
      sub: 'Acceso directo superusuario',
    }
  }
  if (label === 'sshd -t') {
    const isValid = good ?? normalized === 'valid'
    return {
      icon: <CheckIcon size={14} />,
      badgeClass: isValid ? 'is-secure' : 'is-danger',
      badgeText: isValid ? 'Sintaxis válida' : 'Fallo en sintaxis',
      sub: 'Validación del demonio sshd',
    }
  }
  if (label === '2Shell drop-in') {
    const isPresent = good ?? normalized === 'present'
    return {
      icon: <KeyIcon size={14} />,
      badgeClass: isPresent ? 'is-info' : 'is-neutral',
      badgeText: isPresent ? 'Activo (drop-in)' : 'Ausente',
      sub: '00-2shell-key-only.conf',
    }
  }
  return {
    icon: <ShieldIcon size={14} />,
    badgeClass: good ? 'is-secure' : 'is-neutral',
    badgeText: value,
    sub: '',
  }
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
  const policy = getPolicyConfig(label, value, good)

  return (
    <div className="ssh-card">
      <div className="ssh-card__header">
        <span className="ssh-card__icon">{policy.icon}</span>
        <span className="ssh-card__label">{label}</span>
      </div>
      <div className="ssh-card__body">
        <span className={`ssh-policy-badge ${policy.badgeClass}`}>
          {policy.badgeClass === 'is-secure' && <CheckIcon size={10} />}
          {policy.badgeClass === 'is-warning' && <AlertIcon size={10} />}
          {policy.badgeClass === 'is-danger' && <AlertIcon size={10} />}
          {policy.badgeText}
        </span>
      </div>
      {policy.sub && <div className="ssh-card__sub">{policy.sub}</div>}
    </div>
  )
}
