import { EditorModal } from '@/components/EditorModal'
import {
  AlertIcon,
  ChevronRightIcon,
  EyeIcon,
  EyeOffIcon,
  FileIcon,
  FolderIcon,
  PlusIcon,
  RefreshIcon,
  TerminalIcon,
  TrashIcon,
  XIcon,
} from '@/components/Icons'
import { useFileTree } from './useFileTree'

interface FileTreeProps {
  profileId: string
  tabId: string
  onClose: () => void
}

export function FileTree({ profileId, tabId, onClose }: FileTreeProps) {
  const {
    root,
    nodes,
    expanded,
    loading,
    selected,
    setSelected,
    error,
    busy,
    editorTarget,
    setEditorTarget,
    showHidden,
    setShowHidden,
    propertiesTarget,
    setPropertiesTarget,
    properties,
    propertiesLoading,
    propertiesError,
    toggle,
    reloadAll,
    createEntry,
    renameSelected,
    deleteSelected,
    openProperties,
    closeProperties,
    openEntry,
    collapseAll,
    openTerminal,
  } = useFileTree(profileId, tabId)

  const renderLevel = (path: string, depth: number) => {
    const entries = nodes[path]
    if (!entries) {
      return loading.has(path) ? (
        <div className="ft-loading" style={{ paddingLeft: 10 + depth * 12 }}>
          cargando…
        </div>
      ) : null
    }
    const visible = showHidden ? entries : entries.filter((entry) => !entry.hidden)
    return visible.map((entry) => {
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
            onDoubleClick={() => openEntry(entry)}
            onContextMenu={(event) => {
              event.preventDefault()
              setSelected(entry)
              void openProperties(entry)
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
        <button
          className={showHidden ? 'is-active' : ''}
          onClick={() => setShowHidden((value) => !value)}
          title={showHidden ? 'Ocultar archivos ocultos' : 'Mostrar archivos ocultos'}
        >
          {showHidden ? <EyeIcon size={12} /> : <EyeOffIcon size={12} />}
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
          onClick={collapseAll}
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

      {propertiesTarget && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !propertiesLoading) {
              setPropertiesTarget(null)
              closeProperties()
            }
          }}
        >
          <div className="modal modal--compact" role="dialog" aria-modal="true">
            <header className="modal__header">
              <div>
                <h2>
                  Propiedades
                  <span className="panel__sub">{propertiesTarget.name}</span>
                </h2>
                <p className="mono">{propertiesTarget.path}</p>
              </div>
              <button
                className="icon-button"
                onClick={closeProperties}
                disabled={propertiesLoading}
                title="Cerrar"
              >
                <XIcon size={16} />
              </button>
            </header>
            <div className="modal__body">
              {propertiesLoading && <div className="process-table__empty">leyendo…</div>}
              {propertiesError && (
                <div className="inline-alert inline-alert--error">
                  <AlertIcon size={15} />
                  <span>{propertiesError}</span>
                </div>
              )}
              {properties && (
                <div className="monitor-details">
                  <div><span>Tipo</span><strong className="mono">{properties.fileType}</strong></div>
                  <div><span>Tamaño</span><strong className="mono">{properties.sizeHuman}</strong></div>
                  <div><span>En disco</span><strong className="mono">{properties.diskUsageHuman}</strong></div>
                  <div><span>Modo</span><strong className="mono">{properties.mode}</strong></div>
                  <div><span>Propietario</span><strong className="mono">{properties.owner}:{properties.group}</strong></div>
                  <div><span>Inodo</span><strong className="mono">{properties.inode}</strong></div>
                  <div><span>Enlaces</span><strong className="mono">{properties.links}</strong></div>
                  <div><span>Modificado</span><strong className="mono">{properties.modified}</strong></div>
                  <div className="monitor-details__wide"><span>Accedido</span><strong className="mono">{properties.accessed}</strong></div>
                  {properties.target && (
                    <div className="monitor-details__wide"><span>Destino</span><strong className="mono">{properties.target}</strong></div>
                  )}
                </div>
              )}
            </div>
            <footer className="modal__footer">
              <button
                className="ghost-button"
                onClick={() => void navigator.clipboard.writeText(propertiesTarget.path)}
              >
                Copiar ruta
              </button>
              <button
                className="primary-button"
                onClick={closeProperties}
              >
                Cerrar
              </button>
            </footer>
          </div>
        </div>
      )}

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
