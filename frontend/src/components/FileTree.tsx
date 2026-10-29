import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/store/useAppStore'
import { fsService } from '@/services/fs.service'
import { openDirectoryTerminal } from '@/lib/actions'
import { EditorModal } from '@/components/EditorModal'
import {
  AlertIcon,
  ChevronRightIcon,
  FileIcon,
  FolderIcon,
  PlusIcon,
  RefreshIcon,
  TerminalIcon,
  TrashIcon,
  XIcon,
} from '@/components/Icons'
import type { FsEntry } from '@/types'

interface FileTreeProps {
  profileId: string
  tabId: string
  onClose: () => void
}

function joinPath(parent: string, name: string): string {
  return parent.endsWith('/') ? `${parent}${name}` : `${parent}/${name}`
}

const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'tiff', 'svgz',
  'pdf', 'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'tar',
  'so', 'o', 'a', 'bin', 'exe', 'dll', 'class', 'jar', 'wasm',
  'mp3', 'mp4', 'mov', 'avi', 'mkv', 'wav', 'ogg', 'webm',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'sqlite', 'sqlite3', 'db', 'pyc', 'pkl', 'img', 'iso',
])

function isEditable(entry: FsEntry): boolean {
  if (entry.kind !== 'file') return false
  if (entry.sizeBytes > 5 * 1024 * 1024) return false
  const name = entry.name.toLowerCase()
  if (name === 'dockerfile' || name === 'makefile' || name === 'procfile') return true
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return true
  return !BINARY_EXTENSIONS.has(name.slice(dot + 1))
}

function parentOf(path: string): string {
  if (path === '/') return '/'
  const trimmed = path.replace(/\/+$/, '')
  const index = trimmed.lastIndexOf('/')
  return index <= 0 ? '/' : trimmed.slice(0, index)
}

export function FileTree({ profileId, tabId, onClose }: FileTreeProps) {
  const cwd = useAppStore((state) => state.terminalCwd[tabId])
  const profiles = useAppStore((state) => state.profiles)
  const pushToast = useAppStore((state) => state.pushToast)
  const profile = profiles.find((item) => item.id === profileId) ?? null

  const root = cwd || '/'
  const [nodes, setNodes] = useState<Record<string, FsEntry[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<FsEntry | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [editorTarget, setEditorTarget] = useState<FsEntry | null>(null)

  const load = useCallback(
    async (path: string) => {
      setLoading((current) => new Set(current).add(path))
      try {
        const listing = await fsService.list(profileId, path)
        setNodes((current) => ({ ...current, [path]: listing.entries }))
        setError(null)
        return listing.entries
      } catch (err) {
        setError(String(err))
        return []
      } finally {
        setLoading((current) => {
          const next = new Set(current)
          next.delete(path)
          return next
        })
      }
    },
    [profileId],
  )

  useEffect(() => {
    setNodes({})
    setSelected(null)
    setExpanded(new Set([root]))
    void load(root)
  }, [root, load])

  const toggle = async (entry: FsEntry) => {
    const isOpen = expanded.has(entry.path)
    setExpanded((current) => {
      const next = new Set(current)
      if (isOpen) next.delete(entry.path)
      else next.add(entry.path)
      return next
    })
    if (!isOpen && !nodes[entry.path]) {
      await load(entry.path)
    }
  }

  const reloadAll = async () => {
    const paths = new Set<string>([root, ...expanded])
    for (const path of paths) {
      if (path.startsWith(root) || root.startsWith(path)) {
        await load(path)
      }
    }
  }

  const targetDir = useMemo(() => {
    if (!selected) return root
    return selected.kind === 'dir' ? selected.path : parentOf(selected.path)
  }, [selected, root])

  const createEntry = async (directory: boolean) => {
    const label = directory ? 'Nueva carpeta' : 'Nuevo archivo'
    const name = window.prompt(`${label} en ${targetDir}`)
    if (!name?.trim()) return
    const path = joinPath(targetDir, name.trim())
    setBusy(true)
    try {
      await fsService.create(profileId, path, directory)
      pushToast('success', `${directory ? 'Carpeta' : 'Archivo'} creado: ${path}`)
      await reloadAll()
    } catch (err) {
      pushToast('error', String(err))
    } finally {
      setBusy(false)
    }
  }

  const renameSelected = async () => {
    if (!selected) return
    const name = window.prompt('Nuevo nombre', selected.name)
    if (!name?.trim() || name.trim() === selected.name) return
    const target = joinPath(parentOf(selected.path), name.trim())
    setBusy(true)
    try {
      await fsService.rename(profileId, selected.path, target)
      pushToast('success', `Renombrado a ${target}`)
      setSelected(null)
      await reloadAll()
    } catch (err) {
      pushToast('error', String(err))
    } finally {
      setBusy(false)
    }
  }

  const deleteSelected = async () => {
    if (!selected) return
    if (!window.confirm(`¿Eliminar ${selected.path}? Esta acción no se puede deshacer.`)) {
      return
    }
    setBusy(true)
    try {
      await fsService.remove(profileId, selected.path)
      pushToast('success', `Eliminado ${selected.path}`)
      setSelected(null)
      await reloadAll()
    } catch (err) {
      pushToast('error', String(err))
    } finally {
      setBusy(false)
    }
  }

  const openTerminal = () => {
    if (!profile) return
    openDirectoryTerminal(profile, targetDir)
  }

  const renderLevel = (path: string, depth: number) => {
    const entries = nodes[path]
    if (!entries) {
      return loading.has(path) ? (
        <div className="ft-loading" style={{ paddingLeft: 10 + depth * 12 }}>
          cargando…
        </div>
      ) : null
    }
    return entries.map((entry) => {
      const isDir = entry.kind === 'dir'
      const isOpen = expanded.has(entry.path)
      return (
        <div key={entry.path}>
          <button
            className={`ft-row ${selected?.path === entry.path ? 'is-selected' : ''}`}
            style={{ paddingLeft: 6 + depth * 12 }}
            onClick={() => {
              setSelected(entry)
              if (isDir) void toggle(entry)
            }}
            onDoubleClick={() => {
              if (isDir) return
              if (isEditable(entry)) setEditorTarget(entry)
              else pushToast('error', `${entry.name} parece binario; ábrelo por terminal.`)
            }}
            title={isDir ? entry.path : `${entry.path} · doble clic para editar`}
          >
            <span className={`ft-chevron ${isDir && isOpen ? 'is-open' : ''}`}>
              {isDir ? <ChevronRightIcon size={11} /> : null}
            </span>
            <span className={`ft-icon ${isDir ? 'is-dir' : ''}`}>
              {isDir ? <FolderIcon size={13} /> : <FileIcon size={13} />}
            </span>
            <span className="ft-name">{entry.name}</span>
            {entry.symlink && <span className="ft-tag">link</span>}
            {isDir && entry.empty && <span className="ft-tag">vacía</span>}
            {!isDir && <span className="ft-size">{entry.sizeHuman}</span>}
          </button>
          {isDir && isOpen && renderLevel(entry.path, depth + 1)}
        </div>
      )
    })
  }

  return (
    <aside className="file-tree">
      <header className="file-tree__header">
        <span className="file-tree__path" title={root}>
          {root}
        </span>
        <button className="icon-button" onClick={() => void reloadAll()} title="Refrescar">
          <RefreshIcon size={13} />
        </button>
        <button className="icon-button" onClick={onClose} title="Ocultar árbol">
          <XIcon size={13} />
        </button>
      </header>

      <div className="file-tree__actions">
        <button onClick={() => void createEntry(false)} disabled={busy} title="Nuevo archivo">
          <PlusIcon size={12} /> file
        </button>
        <button onClick={() => void createEntry(true)} disabled={busy} title="Nueva carpeta">
          <PlusIcon size={12} /> dir
        </button>
        <button onClick={() => void renameSelected()} disabled={!selected || busy} title="Renombrar">
          ren
        </button>
        <button
          className="is-danger"
          onClick={() => void deleteSelected()}
          disabled={!selected || busy}
          title="Eliminar"
        >
          <TrashIcon size={12} />
        </button>
      </div>

      {error && (
        <div className="inline-alert inline-alert--error file-tree__error">
          <AlertIcon size={13} />
          <span>{error}</span>
        </div>
      )}

      <div className="file-tree__body">
        <button
          className="ft-row ft-row--root"
          onClick={() => setExpanded(new Set([root]))}
          title={root}
        >
          <span className="ft-chevron is-open">
            <ChevronRightIcon size={11} />
          </span>
          <span className="ft-name">{root.split('/').filter(Boolean).pop() || '/'}</span>
          <span className="ft-tag">cwd</span>
        </button>
        {renderLevel(root, 1)}
      </div>

      <footer className="file-tree__footer">
        {selected ? (
          <>
            <div className="ft-detail" title={selected.path}>
              <strong>{selected.name}</strong>
              <span>
                {selected.kind === 'dir'
                  ? `dir · ${selected.mode} · ${selected.modified}`
                  : `${selected.sizeHuman} · ${selected.mode} · ${selected.modified}`}
              </span>
            </div>
            <div className="ft-detail-actions">
              <button onClick={openTerminal} title="Abrir terminal en esta carpeta">
                <TerminalIcon size={12} /> terminal
              </button>
              <button
                onClick={() => void navigator.clipboard.writeText(selected.path)}
                title="Copiar ruta"
              >
                copy
              </button>
            </div>
          </>
        ) : (
          <span className="ft-hint">Selecciona un archivo o carpeta</span>
        )}
      </footer>

      {editorTarget && (
        <EditorModal
          profileId={profileId}
          path={editorTarget.path}
          onClose={() => setEditorTarget(null)}
        />
      )}
    </aside>
  )
}
