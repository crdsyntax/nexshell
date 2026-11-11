import {
  AlertIcon,
  CheckIcon,
  CopyIcon,
  EyeIcon,
  EyeOffIcon,
  FolderIcon,
  KeyIcon,
  RefreshIcon,
  ShieldIcon,
  XIcon,
} from '@/components/Icons'
import { sshService } from '@/services/ssh.service'
import type { GeneratedKeyPair } from '@/types'
import { save as saveDialog } from '@tauri-apps/plugin-dialog'
import { useState } from 'react'

export interface GenerateSshKeyModalProps {
  open: boolean
  onClose: () => void
  onSuccess?: (keyPair: GeneratedKeyPair) => void
  targetProfileName?: string
  onInstallOnHost?: (publicKey: string) => Promise<void> | void
  onUseInProfile?: (keyPair: GeneratedKeyPair) => void
}

export function GenerateSshKeyModal({
  open,
  onClose,
  onSuccess,
  targetProfileName,
  onInstallOnHost,
  onUseInProfile,
}: GenerateSshKeyModalProps) {
  const [algorithm, setAlgorithm] = useState<'ed25519' | 'rsa'>('ed25519')
  const [bits, setBits] = useState<number>(4096)
  const [comment, setComment] = useState('nexshell@local')
  const [passphrase, setPassphrase] = useState('')
  const [confirmPassphrase, setConfirmPassphrase] = useState('')
  const [showPassphrase, setShowPassphrase] = useState(false)
  const [saveToDisk, setSaveToDisk] = useState(true)
  const [destinationPath, setDestinationPath] = useState('~/.ssh/id_ed25519')

  const [generating, setGenerating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<GeneratedKeyPair | null>(null)

  const [showPrivateKey, setShowPrivateKey] = useState(false)
  const [copiedField, setCopiedField] = useState<'pub' | 'priv' | 'fp' | null>(null)
  const [installing, setInstalling] = useState(false)
  const [installSuccess, setInstallSuccess] = useState(false)
  const [savingManual, setSavingManual] = useState(false)

  if (!open) return null

  const handleAlgorithmChange = (algo: 'ed25519' | 'rsa') => {
    setAlgorithm(algo)
    if (saveToDisk) {
      if (algo === 'ed25519' && destinationPath.includes('id_rsa')) {
        setDestinationPath('~/.ssh/id_ed25519')
      } else if (algo === 'rsa' && destinationPath.includes('id_ed25519')) {
        setDestinationPath('~/.ssh/id_rsa')
      }
    }
  }

  const handleBrowseDestination = async () => {
    try {
      const defaultName = algorithm === 'ed25519' ? 'id_ed25519' : 'id_rsa'
      const selected = await saveDialog({
        title: 'Seleccionar ubicación para guardar clave privada SSH',
        defaultPath: defaultName,
      })
      if (typeof selected === 'string' && selected.trim()) {
        setDestinationPath(selected.trim())
      }
    } catch {
      // dialog dismissed or unsupported
    }
  }

  const handleCopy = async (text: string, field: 'pub' | 'priv' | 'fp') => {
    try {
      await navigator.clipboard.writeText(text)
      setCopiedField(field)
      setTimeout(() => setCopiedField(null), 2000)
    } catch {
      // ignore
    }
  }

  const handleGenerate = async () => {
    setError(null)
    if (passphrase && passphrase !== confirmPassphrase) {
      setError('Las frases de contraseña no coinciden.')
      return
    }

    if (saveToDisk && !destinationPath.trim()) {
      setError('Por favor indica una ruta de archivo de destino para guardar la clave.')
      return
    }

    setGenerating(true)
    try {
      const generated = await sshService.generateKey({
        algorithm,
        bits: algorithm === 'rsa' ? bits : undefined,
        comment: comment.trim() || undefined,
        passphrase: passphrase || undefined,
        destinationPath: saveToDisk ? destinationPath.trim() : undefined,
      })
      setResult(generated)
      if (onSuccess) {
        onSuccess(generated)
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      setError(`Error al generar par de claves: ${message}`)
    } finally {
      setGenerating(false)
    }
  }

  const handleManualSave = async () => {
    if (!result) return
    try {
      const defaultName = result.algorithm === 'ed25519' ? 'id_ed25519' : 'id_rsa'
      const selected = await saveDialog({
        title: 'Guardar clave privada SSH en disco',
        defaultPath: defaultName,
      })
      if (typeof selected === 'string' && selected.trim()) {
        setSavingManual(true)
        const saved = await sshService.saveKeyPair({
          privateKey: result.privateKey,
          publicKey: result.publicKey,
          destinationPath: selected.trim(),
        })
        setResult((curr) =>
          curr
            ? {
                ...curr,
                savedPrivatePath: saved.privatePath,
                savedPublicPath: saved.publicPath,
              }
            : null
        )
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      setError(`Error al guardar en disco: ${message}`)
    } finally {
      setSavingManual(false)
    }
  }

  const handleInstall = async () => {
    if (!result || !onInstallOnHost) return
    setInstalling(true)
    setError(null)
    try {
      await onInstallOnHost(result.publicKey)
      setInstallSuccess(true)
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err)
      setError(`Error al instalar clave en el servidor: ${message}`)
    } finally {
      setInstalling(false)
    }
  }

  const handleUseInProfile = () => {
    if (!result || !onUseInProfile) return
    onUseInProfile(result)
    onClose()
  }

  const handleReset = () => {
    setResult(null)
    setError(null)
    setShowPrivateKey(false)
    setInstallSuccess(false)
  }

  return (
    <div
      className="modal-backdrop"
      role="dialog"
      aria-modal="true"
      aria-labelledby="keygen-modal-title"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !generating && !installing) {
          onClose()
        }
      }}
    >
      <div className="modal keygen-modal">
        <header className="modal__header">
          <div>
            <div className="panel__eyebrow">
              <ShieldIcon size={13} /> Seguridad criptográfica · Creador de claves
            </div>
            <h2 id="keygen-modal-title">Generador de par de claves SSH</h2>
            <p className="keygen-modal-subtitle">
              Genera un par de claves asimétricas de forma local. La clave privada se mantiene bajo tu
              control y nunca se transmite por la red sin cifrar.
            </p>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Cerrar modal"
            onClick={onClose}
            disabled={generating || installing}
          >
            <XIcon size={16} />
          </button>
        </header>

        <div className="modal__body keygen-modal__body">
          {error && (
            <div className="inline-alert inline-alert--error" role="alert">
              <AlertIcon size={15} />
              <span>{error}</span>
            </div>
          )}

          {!result ? (
            <div className="keygen-form">
              {/* Algoritmo */}
              <div className="keygen-form-group">
                <label className="keygen-label">Tipo de algoritmo</label>
                <div className="auth-tabs" role="radiogroup" aria-label="Algoritmo de clave">
                  <button
                    type="button"
                    role="radio"
                    aria-checked={algorithm === 'ed25519'}
                    className={algorithm === 'ed25519' ? 'is-active' : ''}
                    onClick={() => handleAlgorithmChange('ed25519')}
                  >
                    <KeyIcon size={14} /> ED25519 (Recomendado)
                  </button>
                  <button
                    type="button"
                    role="radio"
                    aria-checked={algorithm === 'rsa'}
                    className={algorithm === 'rsa' ? 'is-active' : ''}
                    onClick={() => handleAlgorithmChange('rsa')}
                  >
                    <ShieldIcon size={14} /> RSA
                  </button>
                </div>
                <p className="field-hint">
                  {algorithm === 'ed25519'
                    ? 'ED25519 ofrece máxima velocidad, tamaño de clave compacto (256 bits) y seguridad moderna resistente a ataques.'
                    : 'RSA proporciona compatibilidad con sistemas legados. Se recomienda un tamaño de 4096 bits para máxima seguridad.'}
                </p>
              </div>

              {/* RSA Bits */}
              {algorithm === 'rsa' && (
                <div className="keygen-form-group">
                  <label className="keygen-label">Tamaño de clave RSA</label>
                  <div className="auth-tabs" role="radiogroup" aria-label="Tamaño de clave RSA">
                    <button
                      type="button"
                      role="radio"
                      aria-checked={bits === 4096}
                      className={bits === 4096 ? 'is-active' : ''}
                      onClick={() => setBits(4096)}
                    >
                      4096 bits (Recomendado)
                    </button>
                    <button
                      type="button"
                      role="radio"
                      aria-checked={bits === 2048}
                      className={bits === 2048 ? 'is-active' : ''}
                      onClick={() => setBits(2048)}
                    >
                      2048 bits
                    </button>
                  </div>
                </div>
              )}

              {/* Comentario */}
              <label className="field">
                <span>Comentario / Etiqueta</span>
                <input
                  type="text"
                  value={comment}
                  onChange={(e) => setComment(e.target.value)}
                  placeholder="ej. nexshell@local o mi-usuario@empresa"
                  spellCheck={false}
                />
                <span className="field-hint">
                  Identificador al final de la clave pública para reconocer este dispositivo.
                </span>
              </label>

              {/* Passphrase */}
              <div className="keygen-form-row">
                <label className="field">
                  <span>Frase de contraseña (Opcional)</span>
                  <div className="input-with-action">
                    <input
                      type={showPassphrase ? 'text' : 'password'}
                      value={passphrase}
                      onChange={(e) => setPassphrase(e.target.value)}
                      placeholder="Dejar en blanco para clave sin contraseña"
                      spellCheck={false}
                    />
                    <button
                      type="button"
                      className="icon-button"
                      onClick={() => setShowPassphrase(!showPassphrase)}
                      title={showPassphrase ? 'Ocultar' : 'Mostrar'}
                    >
                      {showPassphrase ? <EyeOffIcon size={14} /> : <EyeIcon size={14} />}
                    </button>
                  </div>
                  <span className="field-hint">
                    Cifra la clave privada en disco con AES/KDF robusto.
                  </span>
                </label>

                {passphrase.length > 0 && (
                  <label className="field">
                    <span>Confirmar contraseña</span>
                    <input
                      type={showPassphrase ? 'text' : 'password'}
                      value={confirmPassphrase}
                      onChange={(e) => setConfirmPassphrase(e.target.value)}
                      placeholder="Repetir contraseña"
                      spellCheck={false}
                    />
                  </label>
                )}
              </div>

              {/* Guardar en disco */}
              <div className="keygen-disk-option">
                <label className="check-row">
                  <input
                    type="checkbox"
                    checked={saveToDisk}
                    onChange={(e) => setSaveToDisk(e.target.checked)}
                  />
                  <span>Guardar par de claves directamente en disco local</span>
                </label>

                {saveToDisk && (
                  <div className="field keygen-path-field">
                    <span>Ruta de archivo de clave privada</span>
                    <div className="input-with-action input-with-action--browse">
                      <input
                        type="text"
                        value={destinationPath}
                        onChange={(e) => setDestinationPath(e.target.value)}
                        placeholder="~/.ssh/id_ed25519"
                        spellCheck={false}
                      />
                      <button
                        type="button"
                        className="browse-button"
                        onClick={() => void handleBrowseDestination()}
                      >
                        <FolderIcon size={14} /> Examinar…
                      </button>
                    </div>
                    <span className="field-hint">
                      La clave pública se guardará automáticamente como{' '}
                      <code>{destinationPath}.pub</code> con permisos restrictivos (0600 / 0644).
                    </span>
                  </div>
                )}
              </div>
            </div>
          ) : (
            /* Vista de Clave Generada */
            <div className="keygen-result">
              <div className="inline-alert inline-alert--success">
                <CheckIcon size={16} />
                <div style={{ flex: 1 }}>
                  <strong>¡Par de claves SSH generado con éxito!</strong>
                  <div className="keygen-result-summary">
                    <span>
                      Algoritmo: <strong>{result.algorithm.toUpperCase()}</strong>{' '}
                      {result.bits ? `(${result.bits} bits)` : ''}
                    </span>
                    <span>·</span>
                    <span>Comentario: <code>{result.comment}</code></span>
                  </div>
                </div>
              </div>

              {/* Fingerprint Chip */}
              <div className="keygen-fp-card">
                <div className="keygen-fp-header">
                  <span className="keygen-fp-label">Huella digital SHA256</span>
                  <button
                    type="button"
                    className="ghost-button keygen-copy-btn"
                    onClick={() => handleCopy(result.fingerprint, 'fp')}
                  >
                    {copiedField === 'fp' ? <CheckIcon size={12} /> : <CopyIcon size={12} />}
                    {copiedField === 'fp' ? '¡Copiado!' : 'Copiar'}
                  </button>
                </div>
                <div className="keygen-fp-value">{result.fingerprint}</div>
              </div>

              {/* Rutas de guardado si aplica */}
              {result.savedPrivatePath && (
                <div className="keygen-paths-box">
                  <div className="keygen-path-item">
                    <span className="keygen-path-tag">Clave Privada (0600):</span>
                    <code>{result.savedPrivatePath}</code>
                  </div>
                  <div className="keygen-path-item">
                    <span className="keygen-path-tag">Clave Pública (0644):</span>
                    <code>{result.savedPublicPath}</code>
                  </div>
                </div>
              )}

              {/* Clave Pública */}
              <div className="keygen-key-section">
                <div className="keygen-key-header">
                  <div>
                    <strong>Clave pública (OpenSSH)</strong>
                    <p className="keygen-subtext">
                      Esta es la clave para autorizar en el servidor remoto (en{' '}
                      <code>~/.ssh/authorized_keys</code>).
                    </p>
                  </div>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => handleCopy(result.publicKey, 'pub')}
                  >
                    {copiedField === 'pub' ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
                    {copiedField === 'pub' ? '¡Copiada!' : 'Copiar clave pública'}
                  </button>
                </div>
                <textarea
                  className="keygen-textarea keygen-textarea--public"
                  readOnly
                  value={result.publicKey}
                  rows={3}
                  spellCheck={false}
                  onFocus={(e) => e.target.select()}
                />
              </div>

              {/* Clave Privada */}
              <div className="keygen-key-section">
                <div className="keygen-key-header">
                  <div>
                    <strong>Clave privada (Confidencial)</strong>
                    <p className="keygen-subtext">
                      Nunca compartas este archivo ni su contenido con terceros.
                    </p>
                  </div>
                  <div className="keygen-actions-inline">
                    <button
                      type="button"
                      className="ghost-button"
                      onClick={() => setShowPrivateKey(!showPrivateKey)}
                    >
                      {showPrivateKey ? <EyeOffIcon size={13} /> : <EyeIcon size={13} />}
                      {showPrivateKey ? 'Ocultar' : 'Mostrar clave privada'}
                    </button>
                    {showPrivateKey && (
                      <button
                        type="button"
                        className="secondary-button"
                        onClick={() => handleCopy(result.privateKey, 'priv')}
                      >
                        {copiedField === 'priv' ? <CheckIcon size={13} /> : <CopyIcon size={13} />}
                        {copiedField === 'priv' ? '¡Copiada!' : 'Copiar clave privada'}
                      </button>
                    )}
                  </div>
                </div>

                {showPrivateKey ? (
                  <textarea
                    className="keygen-textarea keygen-textarea--private"
                    readOnly
                    value={result.privateKey}
                    rows={6}
                    spellCheck={false}
                    onFocus={(e) => e.target.select()}
                  />
                ) : (
                  <div
                    className="keygen-private-masked"
                    onClick={() => setShowPrivateKey(true)}
                  >
                    <KeyIcon size={16} />
                    <span>Clave privada oculta por seguridad. Haz clic para revelar el contenido.</span>
                  </div>
                )}
              </div>

              {installSuccess && (
                <div className="inline-alert inline-alert--success">
                  <CheckIcon size={15} />
                  <span>
                    La clave pública se ha instalado exitosamente en el servidor{' '}
                    {targetProfileName ? `(${targetProfileName})` : ''}.
                  </span>
                </div>
              )}
            </div>
          )}
        </div>

        <footer className="modal__footer keygen-modal__footer">
          {!result ? (
            <>
              <button
                type="button"
                className="ghost-button"
                onClick={onClose}
                disabled={generating}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="primary-button"
                onClick={() => void handleGenerate()}
                disabled={generating}
              >
                {generating ? (
                  <>
                    <RefreshIcon size={14} className="spin" /> Generando par de claves…
                  </>
                ) : (
                  <>
                    <KeyIcon size={14} /> Generar par de claves
                  </>
                )}
              </button>
            </>
          ) : (
            <div className="keygen-footer-actions">
              <button
                type="button"
                className="ghost-button"
                onClick={handleReset}
              >
                Generar otra clave
              </button>

              <div className="keygen-footer-primary-group">
                {!result.savedPrivatePath && (
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => void handleManualSave()}
                    disabled={savingManual}
                  >
                    <FolderIcon size={14} /> Guardar en disco…
                  </button>
                )}

                {onInstallOnHost && (
                  <button
                    type="button"
                    className="primary-button"
                    onClick={() => void handleInstall()}
                    disabled={installing || installSuccess}
                  >
                    {installing ? (
                      <>
                        <RefreshIcon size={14} className="spin" /> Instalando…
                      </>
                    ) : installSuccess ? (
                      <>
                        <CheckIcon size={14} /> Instalada en servidor
                      </>
                    ) : (
                      <>
                        <ShieldIcon size={14} /> Instalar en servidor{' '}
                        {targetProfileName ? `(${targetProfileName})` : ''}
                      </>
                    )}
                  </button>
                )}

                {onUseInProfile && (
                  <button
                    type="button"
                    className="primary-button"
                    onClick={handleUseInProfile}
                  >
                    <KeyIcon size={14} /> Usar en esta conexión
                  </button>
                )}

                <button
                  type="button"
                  className="ghost-button"
                  onClick={onClose}
                >
                  Cerrar
                </button>
              </div>
            </div>
          )}
        </footer>
      </div>
    </div>
  )
}
