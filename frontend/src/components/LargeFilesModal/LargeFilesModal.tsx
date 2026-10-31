import { useEffect, useMemo, useState } from 'react'
import { filesystemService } from '@/services/filesystem.service'
import { openDirectoryTerminal } from '@/lib/actions'
import { useAppStore } from '@/store/useAppStore'
import {
  AlertIcon,
  FileIcon,
  FolderIcon,
  InfoIcon,
  RefreshIcon,
  TrashIcon,
  XIcon,
} from '@/components/Icons'
import type { FileProperties, LargeFile, Profile } from '@/types'

interface LargeFilesModalProps {
  open: boolean
  profile: Profile
  onClose: () => void
}

function parentDirectory(path: string): string {
  const index = path.lastIndexOf('/')
  return index <= 0 ? '/' : path.slice(0, index)
}

export function LargeFilesModal({ open, profile, onClose }: LargeFilesModalProps) {
  const pushToast = useAppStore((state) => state.pushToast)
  const [files, setFiles] = useState<LargeFile[]>([])
  const [scanning, setScanning] = useState(false)
  const [scanError, setScanError] = useState<string | null>(null)
  const [scannedAt, setScannedAt] = useState<number | null>(null)

  const [properties, setProperties] = useState<FileProperties | null>(null)
  const [propertiesLoading, setPropertiesLoading] = useState(false)
  const [propertiesError, setPropertiesError] = useState<string | null>(null)

  const [deleteTarget, setDeleteTarget] = useState<LargeFile | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)

  useEffect(() => {
    setFiles([])
    setScanError(null)
    setScannedAt(null)
    setProperties(null)
    setDeleteTarget(null)
  }, [profile.id])

  const command = useMemo(
    () =>
      `${profile.elevated ? 'sudo -n ' : ''}find / -xdev -type f -exec du -h {} + 2>/dev/null | sort -rh | head -n 20`,
    [profile.elevated],
  )

  if (!open) return null

  const scan = async () => {
    if (scanning) return
    setScanning(true)
    setScanError(null)
    try {
      const result = await filesystemService.largeFiles(profile.id)
      setFiles(result)
      setScannedAt(Date.now())
    } catch (error) {
      setFiles([])
      setScanError(String(error))
      setScannedAt(Date.now())
    } finally {
      setScanning(false)
    }
  }

  const showProperties = async (file: LargeFile) => {
    setProperties(null)
    setPropertiesError(null)
    setPropertiesLoading(true)
    try {
      setProperties(await filesystemService.properties(profile.id, file.path))
    } catch (error) {
      setPropertiesError(String(error))
    } finally {
      setPropertiesLoading(false)
    }
  }

  const openFolder = (file: LargeFile) => {
    openDirectoryTerminal(profile, parentDirectory(file.path))
    onClose()
  }

  const askDelete = (file: LargeFile) => {
    setProperties(null)
    setDeleteTarget(file)
    setDeleteError(null)
  }

  const confirmDelete = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    setDeleteError(null)
    try {
      const result = await filesystemService.delete(profile.id, deleteTarget.path)
      setFiles((current) => current.filter((file) => file.path !== deleteTarget.path))
      pushToast('success', result.output || `Deleted ${deleteTarget.path}`)
      setDeleteTarget(null)
    } catch (error) {
      setDeleteError(String(error))
    } finally {
      setDeleting(false)
    }
  }

  return (
    <>
      <div
        className="modal-backdrop"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) onClose()
        }}
      >
        <div className="modal modal--large-files" role="dialog" aria-modal="true">
          <header className="modal__header">
            <div>
              <h2>Largest files on /</h2>
              <p>
                Root filesystem only (<code>-xdev</code>). The scan is read-only and can
                take a while on large disks.
              </p>
            </div>
            <button className="icon-button" onClick={onClose} title="Close">
              <XIcon size={16} />
            </button>
          </header>

          <div className="modal__body">
            <div className="large-files-toolbar">
              <div>
                <code className="large-files-command">{command}</code>
                <p className={`large-files-note ${profile.elevated ? 'is-root' : ''}`}>
                  {profile.elevated
                    ? 'Using passwordless sudo (sudo -n); unreadable directories are included.'
                    : 'Without elevated privileges, unreadable directories are skipped. Enable “Use sudo -n” in the profile for a complete scan.'}
                </p>
              </div>
              <button
                className="top-action"
                onClick={() => void scan()}
                disabled={scanning}
              >
                <RefreshIcon size={14} className={scanning ? 'spin' : ''} />
                {scanning ? 'Scanning…' : files.length > 0 ? 'Rescan' : 'Scan now'}
              </button>
            </div>

            {scanError && (
              <div className="inline-alert inline-alert--error">
                <AlertIcon size={15} />
                <span>{scanError}</span>
              </div>
            )}

            {scanning && (
              <div className="large-files-loading">
                <span className="spinner" />
                <div>
                  <strong>Scanning the root filesystem…</strong>
                  <p>Running find + du. On large disks this can take a minute or more.</p>
                </div>
              </div>
            )}

            {!scanning && files.length > 0 && (
              <>
                <div className="large-files-table">
                  <div className="large-file-row large-file-row--head">
                    <span>#</span>
                    <span>SIZE</span>
                    <span>PATH</span>
                    <span>ACTIONS</span>
                  </div>
                  {files.map((file, index) => (
                    <div className="large-file-row" key={file.path}>
                      <span className="large-file-rank">{index + 1}</span>
                      <span className="large-file-size mono">{file.sizeHuman}</span>
                      <span className="large-file-path mono" title={file.path}>
                        {file.path}
                      </span>
                      <div className="large-file-actions">
                        <button
                          className="icon-button"
                          title="Open containing folder in a new terminal"
                          onClick={() => openFolder(file)}
                        >
                          <FolderIcon size={14} />
                        </button>
                        <button
                          className="icon-button"
                          title="File properties"
                          onClick={() => void showProperties(file)}
                        >
                          <InfoIcon size={14} />
                        </button>
                        <button
                          className="icon-button is-danger"
                          title="Delete file"
                          onClick={() => askDelete(file)}
                        >
                          <TrashIcon size={14} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
                <p className="large-files-footer">
                  Showing {files.length} file{files.length === 1 ? '' : 's'} · scanned at{' '}
                  {scannedAt ? new Date(scannedAt).toLocaleTimeString() : '—'}
                </p>
              </>
            )}

            {!scanning && !scanError && scannedAt !== null && files.length === 0 && (
              <div className="large-files-empty">
                <FileIcon size={20} />
                <strong>No files returned</strong>
                <p>
                  The SSH user may not be able to traverse the filesystem. Enable the
                  elevated option and configure passwordless sudo for <code>find</code>.
                </p>
              </div>
            )}

            {!scanning && scannedAt === null && !scanError && (
              <div className="large-files-empty">
                <FileIcon size={20} />
                <strong>Ready to scan</strong>
                <p>
                  The scan lists the 20 largest regular files on the root filesystem,
                  excluding other mounts.
                </p>
              </div>
            )}
          </div>

          <footer className="modal__footer">
            <span className="large-files-footer">Actions are executed over SSH.</span>
            <button className="ghost-button" onClick={onClose}>
              Close
            </button>
          </footer>
        </div>
      </div>

      {(propertiesLoading || properties || propertiesError) && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setProperties(null)
              setPropertiesError(null)
            }
          }}
        >
          <div className="modal modal--compact" role="dialog" aria-modal="true">
            <header className="modal__header">
              <div>
                <h2>File properties</h2>
                <p className="mono">{properties?.path ?? 'reading metadata…'}</p>
              </div>
              <button
                className="icon-button"
                onClick={() => {
                  setProperties(null)
                  setPropertiesError(null)
                }}
                title="Close"
              >
                <XIcon size={16} />
              </button>
            </header>
            <div className="modal__body">
              {propertiesLoading && (
                <div className="large-files-loading">
                  <span className="spinner" />
                  <strong>Reading stat / du…</strong>
                </div>
              )}
              {propertiesError && (
                <div className="inline-alert inline-alert--error">
                  <AlertIcon size={15} />
                  <span>{propertiesError}</span>
                </div>
              )}
              {properties && (
                <div className="property-grid">
                  <span>Path</span>
                  <strong className="mono">{properties.path}</strong>
                  <span>Type</span>
                  <strong>{properties.fileType}</strong>
                  <span>Apparent size</span>
                  <strong className="mono">
                    {properties.sizeHuman} ({properties.sizeBytes.toLocaleString()} bytes)
                  </strong>
                  <span>Disk usage</span>
                  <strong className="mono">{properties.diskUsageHuman}</strong>
                  <span>Owner / group</span>
                  <strong>
                    {properties.owner}:{properties.group}
                  </strong>
                  <span>Mode</span>
                  <strong className="mono">{properties.mode}</strong>
                  <span>Modified</span>
                  <strong className="mono">{properties.modified}</strong>
                  <span>Accessed</span>
                  <strong className="mono">{properties.accessed}</strong>
                  <span>Inode</span>
                  <strong className="mono">{properties.inode}</strong>
                  <span>Hard links</span>
                  <strong className="mono">{properties.links}</strong>
                  {properties.target && (
                    <>
                      <span>Symlink target</span>
                      <strong className="mono">{properties.target}</strong>
                    </>
                  )}
                </div>
              )}
            </div>
            <footer className="modal__footer">
              <button
                className="ghost-button"
                onClick={() => {
                  setProperties(null)
                  setPropertiesError(null)
                }}
              >
                Close
              </button>
              {properties && (
                <button
                  className="top-action"
                  onClick={() => {
                    openDirectoryTerminal(profile, parentDirectory(properties.path))
                    setProperties(null)
                    onClose()
                  }}
                >
                  <FolderIcon size={14} /> Open folder
                </button>
              )}
            </footer>
          </div>
        </div>
      )}

      {deleteTarget && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !deleting) {
              setDeleteTarget(null)
            }
          }}
        >
          <div className="modal modal--compact" role="dialog" aria-modal="true">
            <header className="modal__header">
              <div>
                <h2>Delete file</h2>
                <p>This operation cannot be undone.</p>
              </div>
              <button
                className="icon-button"
                onClick={() => setDeleteTarget(null)}
                disabled={deleting}
                title="Close"
              >
                <XIcon size={16} />
              </button>
            </header>
            <div className="modal__body">
              <div className="process-summary">
                <div>
                  <span>Size</span>
                  <strong className="mono">{deleteTarget.sizeHuman}</strong>
                </div>
                <div>
                  <span>Mode</span>
                  <strong>{profile.elevated ? 'sudo -n rm' : 'rm (SSH user)'}</strong>
                </div>
                <code>{deleteTarget.path}</code>
              </div>
              <div className="inline-alert inline-alert--error">
                <AlertIcon size={15} />
                <span>
                  This permanently removes the file. If a process has it open, disk space
                  is released only after that process closes it.
                </span>
              </div>
              {deleteError && (
                <div className="inline-alert inline-alert--error">
                  <AlertIcon size={15} />
                  <span>{deleteError}</span>
                </div>
              )}
            </div>
            <footer className="modal__footer">
              <button
                className="ghost-button"
                onClick={() => setDeleteTarget(null)}
                disabled={deleting}
              >
                Cancel
              </button>
              <button
                className="danger-button"
                onClick={() => void confirmDelete()}
                disabled={deleting}
              >
                <TrashIcon size={14} /> {deleting ? 'Deleting…' : 'Delete file'}
              </button>
            </footer>
          </div>
        </div>
      )}
    </>
  )
}
