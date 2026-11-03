import { AlertIcon, CheckIcon, KeyIcon, ShieldIcon, XIcon } from '@/components/Icons'
import { PassphraseField } from '@/components/Sharing/PassphraseField'
import { ShareSummary } from '@/components/Sharing/ShareSummary'
import { useShareConnection } from './useShareConnection'
import type { ShareTarget } from '@/types'

interface ShareConnectionModalProps {
  target: ShareTarget | null
  onClose: () => void
}

export function ShareConnectionModal({ target, onClose }: ShareConnectionModalProps) {
  const state = useShareConnection(target, onClose)

  if (!target || !state.profile) return null

  const { profile, dbTarget } = state

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Compartir conexión">
      <div className="modal share-modal">
        <header className="modal__header">
          <div>
            <div className="panel__eyebrow">
              <ShieldIcon size={13} /> conexión portable .2share · paso {state.step} de 3
            </div>
            <h3>Compartir conexión — {profile.name}</h3>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Cerrar"
            onClick={() => void state.cancelAndClose()}
          >
            <XIcon size={15} />
          </button>
        </header>

        <div className="modal__body share-modal__body">
          {state.error && (
            <div className="banner banner--error" role="alert">
              <AlertIcon size={14} />
              <span>{state.error}</span>
            </div>
          )}

          {state.step === 1 && (
            <div className="share-step" data-testid="share-step-1">
              <ShareSummary profile={profile} database={dbTarget} />

              <div className="share-options">
                <label className="share-toggle">
                  <input
                    type="checkbox"
                    checked={state.mode === 'secrets'}
                    onChange={(event) => state.toggleSecretsMode(event.target.checked)}
                    data-testid="toggle-secrets-mode"
                  />
                  <div>
                    <strong>Incluir credenciales SSH (modo secrets)</strong>
                    <p>
                      Por defecto solo viajan los metadatos (host, puerto, usuario, destino BD).
                    </p>
                  </div>
                </label>

                {state.mode === 'secrets' && (
                  <div className="share-options__secrets" data-testid="secrets-toggles">
                    {profile.authMethod === 'password' && (
                      <label className="share-toggle">
                        <input
                          type="checkbox"
                          checked={state.includeSshPassword}
                          disabled={!profile.hasPassword}
                          onChange={(event) => state.setIncludeSshPassword(event.target.checked)}
                        />
                        <div>
                          <strong>Incluir contraseña SSH</strong>
                          <p>Viajará cifrada con Argon2id + AES-256-GCM.</p>
                        </div>
                      </label>
                    )}

                    {profile.authMethod === 'key' && profile.hasPrivateKey && (
                      <label className="share-toggle">
                        <input
                          type="checkbox"
                          checked={state.includePrivateKey}
                          onChange={(event) => state.setIncludePrivateKey(event.target.checked)}
                        />
                        <div>
                          <strong>Incluir clave privada inline</strong>
                          <p>Incluye la clave privada almacenada en la bóveda local.</p>
                        </div>
                      </label>
                    )}

                    {profile.authMethod === 'key' && profile.keyPath && (
                      <label className="share-toggle">
                        <input
                          type="checkbox"
                          checked={state.includePrivateKeyFile}
                          onChange={(event) =>
                            state.setIncludePrivateKeyFile(event.target.checked)
                          }
                        />
                        <div>
                          <strong>Adjuntar clave privada desde archivo ({profile.keyPath})</strong>
                          <p>
                            Aviso: se leerá el archivo local PEM (máx. 64 KiB) y viajará cifrado en el
                            bundle.
                          </p>
                        </div>
                      </label>
                    )}

                    {profile.authMethod === 'key' &&
                      profile.hasPassphrase &&
                      (state.includePrivateKey || state.includePrivateKeyFile) && (
                        <label className="share-toggle">
                          <input
                            type="checkbox"
                            checked={state.includePassphrase}
                            onChange={(event) => state.setIncludePassphrase(event.target.checked)}
                          />
                          <div>
                            <strong>Incluir passphrase de la clave privada</strong>
                          </div>
                        </label>
                      )}

                    {dbTarget && state.hasActiveDbPassword && (
                      <label className="share-toggle">
                        <input
                          type="checkbox"
                          checked={state.includeDatabasePassword}
                          disabled={!state.includeDatabase}
                          onChange={(event) =>
                            state.setIncludeDatabasePassword(event.target.checked)
                          }
                        />
                        <div>
                          <strong>Incluir contraseña de BD de la sesión activa</strong>
                          <p>
                            El receptor la recibirá solo en memoria (TTL 5 min); nunca se persiste en
                            disco.
                          </p>
                        </div>
                      </label>
                    )}
                  </div>
                )}

                {dbTarget && (
                  <label className="share-toggle">
                    <input
                      type="checkbox"
                      checked={state.includeDatabase}
                      onChange={(event) => state.setIncludeDatabase(event.target.checked)}
                    />
                    <div>
                      <strong>Incluir destino de BD</strong>
                      <p>
                        {dbTarget.user}@{dbTarget.host}:{dbTarget.port} ({dbTarget.engine})
                      </p>
                    </div>
                  </label>
                )}

                <label className="share-toggle">
                  <input
                    type="checkbox"
                    checked={state.includeHostKey}
                    onChange={(event) => state.setIncludeHostKey(event.target.checked)}
                  />
                  <div>
                    <strong>Incluir huella del servidor</strong>
                    <p>Si existe en known_hosts, se mostrará al receptor para verificación TOFU.</p>
                  </div>
                </label>

                <div className="form-field">
                  <label htmlFor="share-expiry-select">Caducidad obligatoria del archivo</label>
                  <select
                    id="share-expiry-select"
                    value={state.expiresInSecs}
                    onChange={(event) => state.setExpiresInSecs(Number(event.target.value))}
                  >
                    <option value={3600}>1 hora</option>
                    <option value={86400}>24 horas (recomendado)</option>
                    <option value={604800}>7 días</option>
                    <option value={2592000}>30 días</option>
                  </select>
                </div>
              </div>
            </div>
          )}

          {state.step === 2 && state.prepared && (
            <div className="share-step" data-testid="share-step-2">
              <div className="banner banner--warn">
                <KeyIcon size={14} />
                <span>
                  Esta frase de 160 bits se muestra una sola vez. Envía el archivo{' '}
                  <code>.2share</code> y la frase por canales distintos.
                </span>
              </div>

              {state.oneTimePassphrase && (
                <PassphraseField
                  label="Frase de descifrado (Crockford Base32)"
                  value={state.oneTimePassphrase}
                  readOnly
                />
              )}

              {state.prepared.warnings.length > 0 && (
                <ul className="share-warnings">
                  {state.prepared.warnings.map((warning) => (
                    <li key={warning}>{warning}</li>
                  ))}
                </ul>
              )}

              <label className="share-toggle share-toggle--confirm">
                <input
                  type="checkbox"
                  checked={state.savedPassphraseConfirmed}
                  onChange={(event) => state.setSavedPassphraseConfirmed(event.target.checked)}
                  data-testid="confirm-saved-passphrase"
                />
                <div>
                  <strong>He guardado la frase en un lugar seguro</strong>
                  <p>No podrá volver a consultarse al avanzar ni al retroceder.</p>
                </div>
              </label>
            </div>
          )}

          {state.step === 3 && (
            <div className="share-step" data-testid="share-step-3">
              {!state.exportResult ? (
                <>
                  <div className="form-field">
                    <label htmlFor="share-dest-input">Ruta de destino (.2share)</label>
                    <div className="share-path-row">
                      <input
                        id="share-dest-input"
                        type="text"
                        value={state.destinationPath}
                        onChange={(event) => {
                          state.setDestinationPath(event.target.value)
                          state.setCloudConfirmed(false)
                        }}
                        placeholder="Selecciona o escribe la ruta del archivo .2share"
                      />
                      <button
                        type="button"
                        className="top-action"
                        onClick={() => void state.pickDestination()}
                      >
                        Examinar…
                      </button>
                    </div>
                  </div>

                  {state.isCloudPath && (
                    <label className="share-toggle share-toggle--warn">
                      <input
                        type="checkbox"
                        checked={state.cloudConfirmed}
                        onChange={(event) => state.setCloudConfirmed(event.target.checked)}
                        data-testid="confirm-cloud-path"
                      />
                      <div>
                        <strong>
                          Advertencia: la ruta parece estar en una carpeta sincronizada en la nube
                        </strong>
                        <p>Confirmo que deseo guardar el archivo cifrado en esta ubicación.</p>
                      </div>
                    </label>
                  )}
                </>
              ) : (
                <div className="share-export-result" data-testid="share-export-result">
                  <div className="banner banner--ok">
                    <CheckIcon size={14} />
                    <span>Archivo .2share exportado con permisos restringidos (0600).</span>
                  </div>
                  <dl className="share-summary__grid">
                    <div>
                      <dt>Ruta</dt>
                      <dd className="share-summary__mono">{state.exportResult.path}</dd>
                    </div>
                    <div>
                      <dt>Tamaño</dt>
                      <dd>{state.exportResult.bytes} bytes</dd>
                    </div>
                    <div>
                      <dt>Caduca</dt>
                      <dd>{new Date(state.exportResult.expiresAt * 1000).toLocaleString()}</dd>
                    </div>
                    <div>
                      <dt>SHA-256</dt>
                      <dd className="share-summary__mono">{state.exportResult.sha256}</dd>
                    </div>
                  </dl>
                  <p className="share-rotate-note">
                    Recomendación de seguridad: rota las credenciales en el servidor tras finalizar el
                    acceso temporal.
                  </p>
                </div>
              )}
            </div>
          )}
        </div>

        <footer className="modal__footer">
          {state.step === 1 && (
            <>
              <button
                type="button"
                className="ghost-button"
                onClick={() => void state.cancelAndClose()}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={state.busy}
                onClick={() => void state.prepareShare()}
                data-testid="btn-prepare-share"
              >
                {state.busy ? 'Generando…' : 'Generar frase y preparar'}
              </button>
            </>
          )}

          {state.step === 2 && (
            <>
              <button
                type="button"
                className="ghost-button"
                onClick={() => void state.backToOptions()}
              >
                Atrás
              </button>
              <button
                type="button"
                className="ghost-button"
                onClick={() => void state.cancelAndClose()}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={!state.savedPassphraseConfirmed}
                onClick={state.proceedToSaveStep}
                data-testid="btn-proceed-save"
              >
                Continuar para guardar
              </button>
            </>
          )}

          {state.step === 3 && (
            <>
              {!state.exportResult ? (
                <>
                  <button
                    type="button"
                    className="ghost-button"
                    onClick={() => void state.cancelAndClose()}
                  >
                    Cancelar
                  </button>
                  <button
                    type="button"
                    className="primary-button"
                    disabled={state.busy || (state.isCloudPath && !state.cloudConfirmed)}
                    onClick={() => void state.saveShareFile()}
                    data-testid="btn-save-share"
                  >
                    {state.busy ? 'Guardando…' : 'Guardar archivo .2share'}
                  </button>
                </>
              ) : (
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => void state.cancelAndClose()}
                >
                  Cerrar
                </button>
              )}
            </>
          )}
        </footer>
      </div>
    </div>
  )
}
