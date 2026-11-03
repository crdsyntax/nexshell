import {
  AlertIcon,
  CheckIcon,
  DatabaseIcon,
  FolderIcon,
  ShieldIcon,
  TerminalIcon,
  XIcon,
} from '@/components/Icons'
import { PassphraseField } from '@/components/Sharing/PassphraseField'
import { ShareSummary } from '@/components/Sharing/ShareSummary'
import { useImportShare } from './useImportShare'
import type { ConflictPolicy, Profile } from '@/types'

interface ImportShareModalProps {
  open: boolean
  onClose: () => void
  onEditProfile?: (profile: Profile) => void
}

export function ImportShareModal({
  open,
  onClose,
  onEditProfile,
}: ImportShareModalProps) {
  const state = useImportShare(onClose, onEditProfile)

  if (!open) return null

  const anyHasHostKey = Boolean(
    state.preview?.connections.some((item) => item.hostKey !== null),
  )
  const anyHasDbPassword = Boolean(
    state.preview?.connections.some(
      (item) => item.database !== null && item.hasDatabasePassword,
    ),
  )

  return (
    <div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="Importar conexión .2share">
      <div className="modal share-modal">
        <header className="modal__header">
          <div>
            <div className="panel__eyebrow">
              <ShieldIcon size={13} /> importador .2share
            </div>
            <h3>Importar conexión compartida</h3>
          </div>
          <button
            type="button"
            className="icon-button"
            aria-label="Cerrar"
            onClick={() => void state.discardAndClose()}
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

          {state.stage === 'select' && (
            <div className="share-step" data-testid="import-stage-select">
              <div className="form-field">
                <label htmlFor="import-file-path">Archivo .2share</label>
                <div className="share-path-row">
                  <input
                    id="import-file-path"
                    type="text"
                    value={state.filePath}
                    onChange={(event) => state.setFilePath(event.target.value)}
                    placeholder="Ruta al archivo .2share"
                  />
                  <button
                    type="button"
                    className="top-action"
                    onClick={() => void state.inspectFile()}
                    data-testid="btn-pick-share"
                  >
                    <FolderIcon size={14} /> Examinar…
                  </button>
                  {state.filePath && !state.header && (
                    <button
                      type="button"
                      className="top-action"
                      onClick={() => void state.inspectFile(state.filePath)}
                      data-testid="btn-inspect-share"
                    >
                      Inspeccionar
                    </button>
                  )}
                </div>
              </div>

              {state.header && (
                <div className="share-header-box" data-testid="share-header-view">
                  <dl className="share-summary__grid">
                    <div>
                      <dt>Share ID</dt>
                      <dd className="share-summary__mono">{state.header.shareId}</dd>
                    </div>
                    <div>
                      <dt>Modo</dt>
                      <dd>{state.header.mode}</dd>
                    </div>
                    <div>
                      <dt>Tamaño</dt>
                      <dd>{state.header.bytes} bytes</dd>
                    </div>
                    <div>
                      <dt>Caduca</dt>
                      <dd>{new Date(state.header.expiresAt * 1000).toLocaleString()}</dd>
                    </div>
                  </dl>

                  {!state.header.expired && (
                    <PassphraseField
                      label="Frase de descifrado"
                      value={state.passphrase}
                      onChange={state.setPassphrase}
                      autoFocus
                    />
                  )}
                </div>
              )}
            </div>
          )}

          {state.stage === 'preview' && state.preview && (
            <div className="share-step" data-testid="import-stage-preview">
              {state.preview.connections.map((conn) => (
                <div key={conn.shareEntryId} className="share-preview-card">
                  <label className="share-preview-card__check">
                    <input
                      type="checkbox"
                      checked={state.selectedIds.includes(conn.shareEntryId)}
                      onChange={() => state.toggleSelection(conn.shareEntryId)}
                    />
                    <span>Seleccionar conexión</span>
                  </label>

                  <ShareSummary
                    profile={conn.profile}
                    database={conn.database}
                    hostKey={conn.hostKey}
                    preview={conn}
                  />

                  {conn.conflicts.length > 0 && (
                    <div className="banner banner--warn" data-testid="conflict-warning">
                      <AlertIcon size={14} />
                      <span>
                        Conflicto detectado con {conn.conflicts.length} perfil(es) existente(s):{' '}
                        {conn.conflicts.map((c) => c.profileName).join(', ')}
                      </span>
                    </div>
                  )}
                </div>
              ))}

              <div className="form-field">
                <label htmlFor="conflict-policy-select">Política ante conflictos</label>
                <select
                  id="conflict-policy-select"
                  value={state.policy}
                  onChange={(event) => state.setPolicy(event.target.value as ConflictPolicy)}
                  data-testid="select-conflict-policy"
                >
                  <option value="skip">Omitir existentes (skip — por defecto)</option>
                  <option value="overwrite">Actualizar existente (overwrite)</option>
                  <option value="duplicate">Duplicar como perfil nuevo (duplicate)</option>
                </select>
              </div>

              {anyHasHostKey && (
                <div className="share-hostkey-box">
                  <label className="share-toggle">
                    <input
                      type="checkbox"
                      checked={state.trustHostKey}
                      onChange={(event) => {
                        state.setTrustHostKey(event.target.checked)
                        if (!event.target.checked) state.setConfirmTrustHostKey(false)
                      }}
                    />
                    <div>
                      <strong>Fijar huella del servidor en known_hosts</strong>
                      <p>Por defecto desactivado para no eludir la verificación TOFU.</p>
                    </div>
                  </label>

                  {state.trustHostKey && (
                    <label className="share-toggle share-toggle--confirm">
                      <input
                        type="checkbox"
                        checked={state.confirmTrustHostKey}
                        onChange={(event) => state.setConfirmTrustHostKey(event.target.checked)}
                      />
                      <div>
                        <strong>
                          Confirmo que he verificado la huella fuera de banda con el emisor
                        </strong>
                      </div>
                    </label>
                  )}
                </div>
              )}

              {anyHasDbPassword && (
                <label className="share-toggle">
                  <input
                    type="checkbox"
                    checked={state.openDatabase}
                    onChange={(event) => state.setOpenDatabase(event.target.checked)}
                  />
                  <div>
                    <strong>Abrir la BD ahora con credencial efímera</strong>
                    <p>La contraseña se mantendrá solo en memoria durante 5 minutos.</p>
                  </div>
                </label>
              )}
            </div>
          )}

          {state.stage === 'report' && state.report && (
            <div className="share-step" data-testid="import-stage-report">
              <div className="banner banner--ok">
                <CheckIcon size={14} />
                <span>
                  Importados: {state.report.imported.length} · Omitidos:{' '}
                  {state.report.skipped.length}
                </span>
              </div>

              {state.report.imported.map((item) => (
                <div key={item.profileId} className="share-imported-row">
                  <span>
                    Perfil <code>{item.profileId}</code> ({item.action})
                  </span>
                  <div className="share-imported-row__actions">
                    {state.report?.needsCredentials.includes(item.profileId) && (
                      <button
                        type="button"
                        className="top-action"
                        onClick={() => state.completeCredentials(item.profileId)}
                        data-testid={`btn-complete-${item.profileId}`}
                      >
                        Completar
                      </button>
                    )}
                    <button
                      type="button"
                      className="top-action"
                      onClick={() => void state.openImportedTerminal(item.profileId)}
                    >
                      <TerminalIcon size={13} /> Abrir terminal
                    </button>
                    {state.report?.ephemeralDatabase?.profileId === item.profileId && (
                      <button
                        type="button"
                        className="top-action"
                        onClick={() => void state.openImportedDatabase(item.profileId)}
                      >
                        <DatabaseIcon size={13} /> Abrir BD
                      </button>
                    )}
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>

        <footer className="modal__footer">
          {state.stage === 'select' && (
            <>
              <button
                type="button"
                className="ghost-button"
                onClick={() => void state.discardAndClose()}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={
                  state.busy ||
                  !state.header ||
                  state.header.expired ||
                  !state.passphrase.trim()
                }
                onClick={() => void state.unlockFile()}
                data-testid="btn-unlock-share"
              >
                {state.busy ? 'Descifrando…' : 'Descifrar vista previa'}
              </button>
            </>
          )}

          {state.stage === 'preview' && (
            <>
              <button
                type="button"
                className="ghost-button"
                onClick={() => void state.discardAndClose()}
              >
                Cancelar
              </button>
              <button
                type="button"
                className="primary-button"
                disabled={
                  state.busy ||
                  state.selectedIds.length === 0 ||
                  (state.trustHostKey && !state.confirmTrustHostKey)
                }
                onClick={() => void state.runImport()}
                data-testid="btn-confirm-import"
              >
                {state.busy ? 'Importando…' : 'Importar conexión'}
              </button>
            </>
          )}

          {state.stage === 'report' && (
            <button
              type="button"
              className="primary-button"
              onClick={() => void state.discardAndClose()}
            >
              Cerrar
            </button>
          )}
        </footer>
      </div>
    </div>
  )
}
