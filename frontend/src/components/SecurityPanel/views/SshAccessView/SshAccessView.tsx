import { AlertIcon, KeyIcon, PlusIcon, RefreshIcon, TrashIcon, XIcon } from '@/components/Icons'

import { useSshAccessView } from './useSshAccessView'

export function SshAccessView({ profileId }: { profileId: string }) {
  const { acknowledged, addOpen, addResult, adding, changeAccess, changing, config, confirmMode, error, keyUser, keys, load, loading, passwordAuth, publicKey, removeKey, setAcknowledged, setAddOpen, setAddResult, setConfirmMode, setKeyUser, setPublicKey, submitKey } = useSshAccessView(profileId)


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
