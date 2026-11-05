import { useEffect } from 'react'
import { DownloadIcon, RefreshIcon, XIcon } from '@/components/Icons'
import { useUpdateStore } from '@/store/updateStore'
import { useAppStore } from '@/store/useAppStore'

const HOURLY_CHECK_MS = 60 * 60 * 1000

export function UpdateModal() {
  const {
    update,
    modalOpen,
    downloading,
    progress,
    error,
    checkNow,
    dismiss,
    installNow,
    clearError,
  } = useUpdateStore()
  const pushToast = useAppStore((state) => state.pushToast)

  useEffect(() => {
    void checkNow(false)
    const interval = setInterval(() => void checkNow(false), HOURLY_CHECK_MS)
    return () => clearInterval(interval)
  }, [checkNow])

  useEffect(() => {
    if (error) {
      pushToast('error', error)
      clearError()
    }
  }, [error, clearError, pushToast])

  if (!modalOpen || !update) return null

  const percentage =
    progress && progress.totalBytes && progress.totalBytes > 0
      ? Math.min(100, Math.round((progress.downloadedBytes / progress.totalBytes) * 100))
      : null

  const downloadedMb = progress ? (progress.downloadedBytes / (1024 * 1024)).toFixed(1) : null
  const totalMb =
    progress && progress.totalBytes ? (progress.totalBytes / (1024 * 1024)).toFixed(1) : null

  return (
    <div className="update-modal-backdrop" onClick={downloading ? undefined : dismiss}>
      <div className="update-modal-card" onClick={(e) => e.stopPropagation()}>
        <header className="update-modal-header">
          <div className="update-modal-header-icon">
            <DownloadIcon size={20} />
          </div>
          <div className="update-modal-header-text">
            <span className="update-badge">Nueva actualización</span>
            <h2>2Shell v{update.version} disponible</h2>
          </div>
          <button
            type="button"
            className="update-modal-close"
            onClick={dismiss}
            disabled={downloading}
            title="Cerrar"
          >
            <XIcon size={16} />
          </button>
        </header>

        <div className="update-modal-body">
          <div className="update-version-comparison">
            <div className="update-ver-box">
              <span className="update-ver-label">Versión actual</span>
              <strong className="update-ver-val mono">v{update.currentVersion}</strong>
            </div>
            <div className="update-ver-arrow">→</div>
            <div className="update-ver-box is-new">
              <span className="update-ver-label">Nueva versión</span>
              <strong className="update-ver-val mono">v{update.version}</strong>
            </div>
          </div>

          {update.date && (
            <p className="update-pub-date">Publicada el {update.date.slice(0, 10)}</p>
          )}

          {update.body && (
            <div className="update-notes">
              <span className="update-notes-title">Notas de la versión</span>
              <div className="update-notes-content">{update.body}</div>
            </div>
          )}

          {downloading && (
            <div className="update-progress-container">
              <div className="update-progress-info">
                <span>Descargando binario...</span>
                <span className="mono">
                  {percentage !== null
                    ? `${percentage}% (${downloadedMb} MB / ${totalMb} MB)`
                    : `${downloadedMb || 0} MB`}
                </span>
              </div>
              <div className="update-progress-bar">
                <div
                  className="update-progress-fill"
                  style={{ width: `${percentage !== null ? percentage : 100}%` }}
                />
              </div>
            </div>
          )}
        </div>

        <footer className="update-modal-footer">
          <button
            type="button"
            className="ghost-button"
            onClick={dismiss}
            disabled={downloading}
          >
            Recordar más tarde
          </button>
          <button
            type="button"
            className="primary-button"
            onClick={() => void installNow()}
            disabled={downloading}
          >
            {downloading ? (
              <>
                <RefreshIcon size={13} className="spin" />
                Instalando…
              </>
            ) : (
              <>
                <DownloadIcon size={13} />
                Actualizar y reiniciar
              </>
            )}
          </button>
        </footer>
      </div>
    </div>
  )
}
