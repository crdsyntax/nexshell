import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store/useAppStore'
import { serviceManager } from '@/services/services.service'
import { ServiceChip } from '@/components/ServiceChip'
import {
  AlertIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  FileIcon,
  FolderIcon,
  InfoIcon,
  PlayIcon,
  PlusIcon,
  RefreshIcon,
  RestartIcon,
  SaveIcon,
  SearchIcon,
  ServerIcon,
  StopIcon,
  TrashIcon,
  XIcon,
} from '@/components/Icons'
import { basename } from '@/lib/format'
import { CreateConfigModal } from './CreateConfigModal'
import type {
  ConfigEntry,
  ServiceActionResult,
  ServiceStatus,
  WebServiceInfo,
} from '@/types'

interface ServicesPanelProps {
  profileId: string
}

const ACTION_LABEL: Record<string, string> = {
  start: 'Start',
  stop: 'Stop',
  restart: 'Restart',
  reload: 'Reload',
  test: 'Test config',
}

export function ServicesPanel({ profileId }: ServicesPanelProps) {
  const services = useAppStore((state) => state.services[profileId])
  const statuses = useAppStore((state) => state.serviceStatuses[profileId])
  const profiles = useAppStore((state) => state.profiles)
  const servers = useAppStore((state) => state.servers)
  const setServices = useAppStore((state) => state.setServices)
  const setServiceStatuses = useAppStore((state) => state.setServiceStatuses)
  const pushToast = useAppStore((state) => state.pushToast)

  const [selected, setSelected] = useState<string | null>(null)
  const [pinnedChip, setPinnedChip] = useState<string | null>(null)
  const [detecting, setDetecting] = useState(false)
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [configs, setConfigs] = useState<ConfigEntry[]>([])
  const [dirs, setDirs] = useState<string[]>([])
  const [searchQuery, setSearchQuery] = useState('')
  const [collapsedFolders, setCollapsedFolders] = useState<Record<string, boolean>>({})
  const [createModalOpen, setCreateModalOpen] = useState(false)
  const [createModalInitialDir, setCreateModalInitialDir] = useState<string | undefined>(undefined)
  const [togglingSite, setTogglingSite] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [configPath, setConfigPath] = useState('')
  const [content, setContent] = useState('')
  const [original, setOriginal] = useState('')
  const [configLoading, setConfigLoading] = useState(false)
  const [configError, setConfigError] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [busyAction, setBusyAction] = useState<string | null>(null)
  const [result, setResult] = useState<ServiceActionResult | null>(null)
  const [resultExpanded, setResultExpanded] = useState(false)
  const [statusDetailsOpen, setStatusDetailsOpen] = useState(false)
  const [logs, setLogs] = useState<string | null>(null)
  const [configNonce, setConfigNonce] = useState(0)

  const gutterRef = useRef<HTMLDivElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  const lineCount = useMemo(() => {
    if (!content) return 1
    return content.split('\n').length
  }, [content])

  const handleEditorScroll = () => {
    if (gutterRef.current && textareaRef.current) {
      gutterRef.current.scrollTop = textareaRef.current.scrollTop
    }
  }

  const profile = profiles.find((item) => item.id === profileId)
  const server = servers[profileId]

  const current = useMemo(
    () => services?.find((service) => service.name === selected) ?? null,
    [services, selected],
  )
  const currentStatus = useMemo(
    () => statuses?.find((status) => status.service === selected) ?? null,
    [statuses, selected],
  )

  const statusFor = (name: string): ServiceStatus | undefined =>
    statuses?.find((status) => status.service === name)

  const refreshStatuses = useCallback(
    async (list: WebServiceInfo[]) => {
      const installed = list.filter((service) => service.installed)
      const next = await Promise.all(
        installed.map((service) =>
          serviceManager.status(profileId, service.name).catch(() => null),
        ),
      )
      const valid = next.filter((status): status is ServiceStatus => status !== null)
      setServiceStatuses(profileId, valid)
    },
    [profileId, setServiceStatuses],
  )

  const detect = useCallback(async () => {
    setDetecting(true)
    try {
      const list = await serviceManager.detect(profileId)
      setServices(profileId, list)
      const installed = list.find((service) => service.installed)
      setSelected((previous) => {
        if (previous && list.some((service) => service.name === previous)) return previous
        return installed?.name ?? list[0]?.name ?? null
      })
      setPinnedChip(null)
      await refreshStatuses(list)
    } catch (error) {
      pushToast('error', `Service detection failed: ${String(error)}`)
    } finally {
      setDetecting(false)
    }
  }, [profileId, pushToast, refreshStatuses, setServices])

  useEffect(() => {
    setSelected(null)
    setPinnedChip(null)
    setConfigs([])
    setDirs([])
    setSearchQuery('')
    setCollapsedFolders({})
    setConfigPath('')
    setContent('')
    setOriginal('')
    setConfigError(null)
    setResult(null)
    setResultExpanded(false)
    setStatusDetailsOpen(false)
    setLogs(null)
    void detect()
  }, [detect])

  useEffect(() => {
    if (!autoRefresh) return
    const timer = window.setInterval(() => {
      if (services) void refreshStatuses(services)
    }, 20_000)
    return () => window.clearInterval(timer)
  }, [autoRefresh, services, refreshStatuses])

  useEffect(() => {
    setStatusDetailsOpen(false)
    setResultExpanded(false)
    setResult(null)
    setLogs(null)
    setConfigError(null)
    setSearchQuery('')
    setCollapsedFolders({})
  }, [selected])

  useEffect(() => {
    if (!pinnedChip) return
    const closeOnOutsideClick = (event: PointerEvent) => {
      const target = event.target as HTMLElement | null
      if (!target?.closest('.service-chip-wrap')) setPinnedChip(null)
    }
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setPinnedChip(null)
    }
    document.addEventListener('pointerdown', closeOnOutsideClick)
    document.addEventListener('keydown', closeOnEscape)
    return () => {
      document.removeEventListener('pointerdown', closeOnOutsideClick)
      document.removeEventListener('keydown', closeOnEscape)
    }
  }, [pinnedChip])

  const loadConfig = useCallback(
    async (path: string) => {
      if (!selected) return
      setConfigLoading(true)
      setConfigError(null)
      setConfigPath(path)
      setResult(null)
      setResultExpanded(false)
      try {
        const file = await serviceManager.configRead(profileId, selected, path)
        setContent(file.content)
        setOriginal(file.content)
      } catch (error) {
        const message = String(error)
        setConfigError(message)
        setContent('')
        setOriginal('')
        pushToast('error', message)
      } finally {
        setConfigLoading(false)
      }
    },
    [profileId, selected, pushToast],
  )

  useEffect(() => {
    if (!selected) return
    let active = true
    Promise.all([
      serviceManager.configList(profileId, selected),
      serviceManager.dirsList(profileId, selected).catch(() => []),
    ])
      .then(([list, dirList]) => {
        if (!active) return
        setConfigs(list)
        setDirs(dirList)
        if (list.length > 0) {
          if (!configPath || !list.some((item) => item.path === configPath)) {
            void loadConfig(list[0].path)
          }
        } else {
          setConfigPath('')
          setContent('')
          setOriginal('')
        }
      })
      .catch((error) => {
        if (active) pushToast('error', String(error))
      })
    return () => {
      active = false
    }
  }, [profileId, selected, configNonce, loadConfig, configPath, pushToast])

  const runAction = async (action: string) => {
    if (!selected) return
    setBusyAction(action)
    setResult(null)
    setResultExpanded(false)
    try {
      const outcome = await serviceManager.action(profileId, selected, action)
      setResult(outcome)
      setResultExpanded(!outcome.ok)
      if (outcome.ok) {
        pushToast(
          'success',
          `${selected}: ${ACTION_LABEL[action] ?? action} completed`,
        )
      } else {
        pushToast(
          'error',
          `${selected}: ${ACTION_LABEL[action] ?? action} failed`,
        )
      }
      if (services) await refreshStatuses(services)
    } catch (error) {
      pushToast('error', String(error))
    } finally {
      setBusyAction(null)
    }
  }

  const saveConfig = async () => {
    if (!selected || !configPath) return
    setSaving(true)
    setResult(null)
    setResultExpanded(false)
    try {
      const outcome = await serviceManager.configWrite(
        profileId,
        selected,
        configPath,
        content,
      )
      setResult(outcome)
      setResultExpanded(!outcome.ok)
      if (outcome.ok) {
        setOriginal(content)
        pushToast('success', `${basename(configPath)} saved and validated`)
      } else {
        pushToast('error', 'Validation failed — backup restored')
      }
    } catch (error) {
      pushToast('error', String(error))
    } finally {
      setSaving(false)
    }
  }

  const showLogs = async () => {
    if (!selected) return
    try {
      const output = await serviceManager.logs(profileId, selected, 250)
      setLogs(output)
    } catch (error) {
      pushToast('error', String(error))
    }
  }

  const isSitesAvailable = configPath.includes('/sites-available/')
  const siteBaseName = basename(configPath)
  const isSiteEnabled = useMemo(() => {
    if (!isSitesAvailable) return false
    return configs.some(
      (c) => c.path.includes('/sites-enabled/') && basename(c.path) === siteBaseName,
    )
  }, [configs, isSitesAvailable, siteBaseName])

  const isPrimaryConfig = current?.configFile === configPath

  const folderGroups = useMemo(() => {
    const root =
      current?.configRoot ||
      (selected === 'nginx'
        ? '/etc/nginx'
        : selected === 'apache2'
        ? '/etc/apache2'
        : '/etc/httpd')
    const allDirs = Array.from(new Set([root, ...dirs]))

    allDirs.sort((a, b) => {
      if (a === root) return -1
      if (b === root) return 1
      return a.localeCompare(b)
    })

    const dirMap = new Map<string, ConfigEntry[]>()
    allDirs.forEach((d) => dirMap.set(d, []))

    configs.forEach((file) => {
      const lastSlash = file.path.lastIndexOf('/')
      const fileDir = lastSlash > 0 ? file.path.slice(0, lastSlash) : root
      if (!dirMap.has(fileDir)) {
        dirMap.set(fileDir, [])
      }
      dirMap.get(fileDir)!.push(file)
    })

    const groups: { dir: string; label: string; files: ConfigEntry[] }[] = []
    dirMap.forEach((files, dir) => {
      const label = dir === root ? 'raíz' : dir.replace(root + '/', '')
      groups.push({ dir, label, files })
    })
    return groups
  }, [current?.configRoot, selected, dirs, configs])

  const isFolderExpanded = useCallback(
    (dir: string, fileCount: number): boolean => {
      if (searchQuery.trim().length > 0) return true
      if (collapsedFolders[dir] !== undefined) {
        return !collapsedFolders[dir]
      }
      return fileCount > 0
    },
    [searchQuery, collapsedFolders],
  )

  const toggleFolderCollapse = (dir: string, fileCount: number) => {
    const currentlyOpen = isFolderExpanded(dir, fileCount)
    setCollapsedFolders((prev) => ({ ...prev, [dir]: currentlyOpen }))
  }

  const toggleAllFolders = () => {
    const anyClosed = folderGroups.some((g) => !isFolderExpanded(g.dir, g.files.length))
    const next: Record<string, boolean> = {}
    folderGroups.forEach((g) => {
      next[g.dir] = !anyClosed
    })
    setCollapsedFolders(next)
  }

  const filteredGroups = useMemo(() => {
    const q = searchQuery.trim().toLowerCase()
    if (!q) return folderGroups

    return folderGroups
      .map((group) => {
        const matchFolder = group.label.toLowerCase().includes(q)
        if (matchFolder) return group
        const matchingFiles = group.files.filter(
          (f) =>
            basename(f.path).toLowerCase().includes(q) ||
            f.path.toLowerCase().includes(q),
        )
        return {
          ...group,
          files: matchingFiles,
        }
      })
      .filter((group) => group.files.length > 0 || group.label.toLowerCase().includes(q))
  }, [folderGroups, searchQuery])

  const formatSize = (bytes: number): string => {
    if (bytes < 1024) return `${bytes} B`
    return `${(bytes / 1024).toFixed(1)} KB`
  }

  const handleToggleSite = async () => {
    if (!selected || !configPath || !isSitesAvailable || togglingSite) return
    setTogglingSite(true)
    try {
      const nextState = !isSiteEnabled
      const res = await serviceManager.configToggleSite(
        profileId,
        selected,
        siteBaseName,
        nextState,
      )
      if (res.ok) {
        pushToast(
          'success',
          nextState
            ? `Sitio "${siteBaseName}" habilitado en sites-enabled.`
            : `Sitio "${siteBaseName}" deshabilitado.`,
        )
        setConfigNonce((v) => v + 1)
      } else {
        pushToast('error', `Error al alternar sitio: ${res.output}`)
      }
    } catch (err) {
      pushToast('error', String(err))
    } finally {
      setTogglingSite(false)
    }
  }

  const handleDeleteConfig = async () => {
    if (!selected || !configPath || isPrimaryConfig || deleting) return
    const name = basename(configPath)
    const confirmed = window.confirm(
      `¿Deseas eliminar permanentemente "${name}"?\nSe ejecutará una verificación de sintaxis con rollback automático si la prueba falla.`,
    )
    if (!confirmed) return

    setDeleting(true)
    try {
      const res = await serviceManager.configDelete(profileId, selected, configPath)
      if (res.ok) {
        pushToast('success', `Archivo "${name}" eliminado correctamente.`)
        setConfigPath('')
        setContent('')
        setOriginal('')
        setConfigNonce((v) => v + 1)
      } else {
        pushToast('error', `No se pudo eliminar: ${res.output}`)
      }
    } catch (err) {
      pushToast('error', String(err))
    } finally {
      setDeleting(false)
    }
  }

  const handleOpenCreateModal = (dir?: string) => {
    setCreateModalInitialDir(dir)
    setCreateModalOpen(true)
  }

  const handleConfigCreated = (newPath: string) => {
    setConfigNonce((v) => v + 1)
    setTimeout(() => {
      void loadConfig(newPath)
    }, 300)
  }

  const dirty = content !== original

  return (
    <div className="panel services-panel">
      <div className="panel__header services-panel__header">
        <div>
          <div className="panel__eyebrow">
            <ServerIcon size={14} /> web stack control
          </div>
          <h2>
            Web services
            <span className="panel__sub">{profile?.name ?? profileId}</span>
          </h2>
          <p className="panel__description">
            {server?.osName ?? 'remote host'} · validated config edits with automatic
            rollback
          </p>
        </div>
        <div className="panel__actions">
          <label className="check-row check-row--inline">
            <input
              type="checkbox"
              checked={autoRefresh}
              onChange={(event) => setAutoRefresh(event.target.checked)}
            />
            auto refresh
          </label>
          <button className="top-action" onClick={() => void detect()} disabled={detecting}>
            <RefreshIcon size={14} className={detecting ? 'spin' : ''} />
            {detecting ? 'Scanning…' : 'Rescan'}
          </button>
        </div>
      </div>

      <div className="service-command-bar">
        <div className="service-chips">
          {!services && <span className="service-chip-empty">Scanning services…</span>}
          {services && services.length === 0 && (
            <span className="service-chip-empty">
              No nginx, apache2 or httpd binary found
            </span>
          )}
          {services?.map((service) => (
            <ServiceChip
              key={service.name}
              service={service}
              status={statusFor(service.name)}
              selected={selected === service.name}
              pinned={pinnedChip === service.name}
              onSelect={() => setSelected(service.name)}
              onPin={() => setPinnedChip(service.name)}
            />
          ))}
        </div>

        {current?.installed && (
          <div className="service-actions">
            <button
              className="top-action"
              onClick={() => void runAction('start')}
              disabled={busyAction !== null || currentStatus?.active === true}
              title="Start service"
            >
              <PlayIcon size={13} /> Start
            </button>
            <button
              className="top-action"
              onClick={() => void runAction('stop')}
              disabled={busyAction !== null || currentStatus?.active === false}
              title="Stop service"
            >
              <StopIcon size={13} /> Stop
            </button>
            <button
              className="top-action"
              onClick={() => void runAction('restart')}
              disabled={busyAction !== null}
              title="Restart service"
            >
              <RestartIcon size={13} /> Restart
            </button>
            <button
              className="top-action"
              onClick={() => void runAction('reload')}
              disabled={busyAction !== null}
              title="Reload configuration"
            >
              <RefreshIcon size={13} /> Reload
            </button>
            <button
              className="top-action"
              onClick={() => void runAction('test')}
              disabled={busyAction !== null}
              title="Validate configuration"
            >
              <CheckIcon size={13} /> Test
            </button>
            <button className="top-action" onClick={() => void showLogs()}>
              <FileIcon size={13} /> Logs
            </button>
          </div>
        )}
      </div>

      {current && !current.installed && (
        <div className="inline-alert">
          <AlertIcon size={15} />
          <span>
            {current.name} is not installed. Install it with{' '}
            {server?.packageManager
              ? `your package manager (${server.packageManager})`
              : 'your package manager'}{' '}
            and rescan.
          </span>
        </div>
      )}

      {current && current.installed && (
        <>
          <div className="service-status-line">
            <span
              className={`status-chip ${currentStatus?.active ? 'is-online' : 'is-offline'}`}
            >
              <span className="status-chip__dot" />
              {currentStatus?.state ? currentStatus.state.toUpperCase() : 'UNKNOWN'}
            </span>
            <span className="service-status-tag mono">{current.serviceUnit}</span>
            {currentStatus?.pid && (
              <span className="service-status-tag mono">PID {currentStatus.pid}</span>
            )}
            <span className="service-status-tag service-status-path mono" title={current.configFile}>
              {current.configFile}
            </span>
            {currentStatus?.detail && (
              <button
                className="service-status-toggle"
                onClick={() => setStatusDetailsOpen((value) => !value)}
              >
                <InfoIcon size={12} />
                <span>{statusDetailsOpen ? 'Ocultar estado' : 'Detalles systemd'}</span>
              </button>
            )}
          </div>

          {statusDetailsOpen && currentStatus?.detail && (
            <pre className="service-status-detail service-status-detail--inline">
              {currentStatus.detail}
            </pre>
          )}

          {result && (
            <div
              className={`command-result ${
                result.ok ? 'command-result--ok' : 'command-result--error'
              } ${resultExpanded ? '' : 'is-collapsed'}`}
            >
              <button
                type="button"
                className="command-result__head"
                onClick={() => setResultExpanded((value) => !value)}
                aria-expanded={resultExpanded}
              >
                {result.ok ? <CheckIcon size={14} /> : <AlertIcon size={14} />}
                <strong>{result.action}</strong>
                <span>exit {result.exitCode}</span>
                {result.backupPath && (
                  <span className="mono">backup {result.backupPath}</span>
                )}
                <span className="command-result__toggle">
                  <ChevronDownIcon
                    size={12}
                    className={resultExpanded ? 'chevron-up' : ''}
                  />
                  {resultExpanded ? 'Hide output' : 'Show output'}
                </span>
              </button>
              {resultExpanded && <pre>{result.output}</pre>}
            </div>
          )}

          <div className="config-workspace">
            <aside className="config-list config-explorer">
              <div className="config-tree-header">
                <div className="config-tree-header__title">
                  <FolderIcon size={14} className="config-tree-header__icon" />
                  <span>Archivos</span>
                  <span className="config-tree-count-pill mono">{configs.length}</span>
                </div>
                <div className="config-tree-header__actions">
                  <button
                    type="button"
                    className="icon-button icon-button--subtle"
                    onClick={toggleAllFolders}
                    title="Alternar expandir / colapsar carpetas"
                  >
                    <ChevronDownIcon size={13} />
                  </button>
                  <button
                    type="button"
                    className="icon-button icon-button--subtle"
                    onClick={() => setConfigNonce((value) => value + 1)}
                    title="Recargar archivos"
                  >
                    <RefreshIcon size={13} />
                  </button>
                  <button
                    type="button"
                    className="primary-button primary-button--small config-tree-new-btn"
                    onClick={() => handleOpenCreateModal()}
                    title="Crear nuevo archivo de configuración"
                  >
                    <PlusIcon size={12} />
                    <span>Nuevo</span>
                  </button>
                </div>
              </div>

              <div className="config-tree-search">
                <SearchIcon size={12} className="config-tree-search__icon" />
                <input
                  type="text"
                  placeholder="Buscar archivo o carpeta…"
                  value={searchQuery}
                  onChange={(e) => setSearchQuery(e.target.value)}
                  spellCheck={false}
                />
                {searchQuery && (
                  <button
                    type="button"
                    className="config-tree-search__clear"
                    onClick={() => setSearchQuery('')}
                    title="Limpiar filtro"
                  >
                    <XIcon size={11} />
                  </button>
                )}
              </div>

              <div className="config-tree-body">
                {filteredGroups.map((group) => {
                  const isOpen = isFolderExpanded(group.dir, group.files.length)
                  const isEmpty = group.files.length === 0
                  return (
                    <div
                      key={group.dir}
                      className={`config-tree-node ${isEmpty ? 'is-empty' : ''}`}
                    >
                      <div
                        className="config-tree-folder-row"
                        onClick={() => toggleFolderCollapse(group.dir, group.files.length)}
                      >
                        <span className={`config-tree-chevron ${isOpen ? 'is-open' : ''}`}>
                          <ChevronRightIcon size={11} />
                        </span>
                        <FolderIcon
                          size={13}
                          className={`config-tree-folder-icon ${isOpen ? 'is-open' : ''}`}
                        />
                        <span className="config-tree-folder-name" title={group.dir}>
                          {group.label}
                        </span>
                        <span className="config-tree-folder-count mono">{group.files.length}</span>

                        <button
                          type="button"
                          className="config-tree-folder-add-btn"
                          onClick={(e) => {
                            e.stopPropagation()
                            handleOpenCreateModal(group.dir)
                          }}
                          title={`Crear archivo en ${group.label}`}
                        >
                          <PlusIcon size={11} />
                        </button>
                      </div>

                      {isOpen && (
                        <div className="config-tree-children">
                          {group.files.map((file) => {
                            const isAvailable = file.path.includes('/sites-available/')
                            const isEnabled =
                              isAvailable &&
                              configs.some(
                                (c) =>
                                  c.path.includes('/sites-enabled/') &&
                                  basename(c.path) === basename(file.path),
                              )
                            const isActive = configPath === file.path

                            return (
                              <button
                                key={file.path}
                                type="button"
                                className={`config-tree-file-row ${isActive ? 'is-active' : ''}`}
                                onClick={() => void loadConfig(file.path)}
                                title={file.path}
                              >
                                {isAvailable && (
                                  <span
                                    className={`config-site-indicator ${
                                      isEnabled ? 'is-enabled' : 'is-disabled'
                                    }`}
                                    title={
                                      isEnabled
                                        ? 'Habilitado en sites-enabled'
                                        : 'No habilitado en sites-enabled'
                                    }
                                  />
                                )}
                                <FileIcon size={12} className="config-tree-file-icon" />
                                <span className="config-tree-file-name">{basename(file.path)}</span>
                                {file.isSymlink && (
                                  <span
                                    className="config-tree-symlink-tag"
                                    title="Enlace simbólico"
                                  >
                                    link
                                  </span>
                                )}
                                <span className="config-tree-file-size mono">
                                  {formatSize(file.size)}
                                </span>
                              </button>
                            )
                          })}
                          {isEmpty && (
                            <div className="config-tree-empty-folder">
                              <span>Carpeta vacía</span>
                              <button
                                type="button"
                                className="config-tree-empty-add"
                                onClick={() => handleOpenCreateModal(group.dir)}
                              >
                                + Crear archivo
                              </button>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}

                {filteredGroups.length === 0 && (
                  <div className="config-tree-no-results">
                    <span>No se encontraron archivos</span>
                    {searchQuery && (
                      <button
                        type="button"
                        className="ghost-button ghost-button--tiny"
                        onClick={() => setSearchQuery('')}
                      >
                        Limpiar búsqueda
                      </button>
                    )}
                  </div>
                )}
              </div>
            </aside>

            <section className="config-editor">
              <div className="config-editor__head">
                <div className="config-editor__path-badge">
                  <FileIcon size={13} />
                  <span className="mono">{configPath || 'Selecciona un archivo'}</span>
                  {configPath && (
                    <span className="config-editor__lines-count mono">
                      {lineCount} {lineCount === 1 ? 'línea' : 'líneas'}
                    </span>
                  )}
                </div>
                <div className="config-editor__actions">
                  {isSitesAvailable && configPath && (
                    <button
                      type="button"
                      className={`site-toggle-btn ${
                        isSiteEnabled ? 'site-toggle-btn--enabled' : 'site-toggle-btn--disabled'
                      }`}
                      onClick={() => void handleToggleSite()}
                      disabled={togglingSite || saving}
                      title={
                        isSiteEnabled
                          ? 'Deshabilitar sitio (eliminar symlink en sites-enabled)'
                          : 'Habilitar sitio (crear symlink en sites-enabled)'
                      }
                    >
                      {isSiteEnabled ? <CheckIcon size={12} /> : <PlusIcon size={12} />}
                      <span>
                        {togglingSite
                          ? 'Actualizando…'
                          : isSiteEnabled
                          ? 'Habilitado en sites-enabled'
                          : 'Habilitar sitio'}
                      </span>
                    </button>
                  )}

                  {configPath && !isPrimaryConfig && (
                    <button
                      type="button"
                      className="top-action top-action--danger"
                      onClick={() => void handleDeleteConfig()}
                      disabled={deleting || saving}
                      title="Eliminar este archivo de configuración"
                    >
                      <TrashIcon size={12} />
                      <span>{deleting ? 'Eliminando…' : 'Eliminar'}</span>
                    </button>
                  )}

                  {dirty && <span className="dirty-badge">MODIFICADO</span>}
                  <button
                    className="top-action"
                    onClick={() => {
                      setContent(original)
                      setResult(null)
                      setResultExpanded(false)
                    }}
                    disabled={!dirty || saving}
                    title="Restaurar contenido original"
                  >
                    Revert
                  </button>
                  <button
                    className="primary-button primary-button--small"
                    onClick={() => void saveConfig()}
                    disabled={!configPath || !dirty || saving}
                  >
                    <SaveIcon size={13} />
                    {saving ? 'Validando…' : 'Save & test'}
                  </button>
                </div>
              </div>
              {configError ? (
                <div className="config-error">
                  <div>
                    <AlertIcon size={16} />
                    <strong>Cannot read this configuration file</strong>
                  </div>
                  <p>{configError}</p>
                  <p className="field-hint">
                    If the file is owned by root, edit the profile and enable
                    “Use sudo -n for service actions”, then verify that the SSH user
                    has passwordless sudo (NOPASSWD).
                  </p>
                  <button
                    className="top-action"
                    onClick={() => void loadConfig(configPath)}
                    disabled={configLoading || !configPath}
                  >
                    <RefreshIcon size={13} /> Retry
                  </button>
                </div>
              ) : (
                <div className="config-editor__body">
                  <div
                    ref={gutterRef}
                    className="config-editor__gutter"
                    aria-hidden="true"
                  >
                    {Array.from({ length: lineCount }, (_, i) => (
                      <div key={i + 1} className="config-editor__line-no mono">
                        {i + 1}
                      </div>
                    ))}
                  </div>
                  <textarea
                    ref={textareaRef}
                    className="config-textarea"
                    value={configLoading ? 'loading…' : content}
                    onChange={(event) => setContent(event.target.value)}
                    onScroll={handleEditorScroll}
                    spellCheck={false}
                    disabled={configLoading || !configPath}
                    placeholder={
                      configPath
                        ? 'Archivo vacío'
                        : 'Selecciona un archivo de configuración para inspeccionar o editar su contenido.'
                    }
                  />
                </div>
              )}
            </section>
          </div>
        </>
      )}

      {logs !== null && (
        <div className="log-drawer">
          <div className="log-drawer__head">
            <span>
              <FileIcon size={13} /> {current?.logFile ?? 'service log'}
            </span>
            <div>
              <button className="top-action" onClick={() => void showLogs()}>
                <RefreshIcon size={13} /> Refresh
              </button>
              <button className="icon-button" onClick={() => setLogs(null)}>
                ✕
              </button>
            </div>
          </div>
          <pre>{logs || 'log file is empty or not readable'}</pre>
        </div>
      )}

      {createModalOpen && current && selected && (
        <CreateConfigModal
          profileId={profileId}
          serviceName={selected}
          configRoot={current.configRoot}
          directories={dirs.length > 0 ? dirs : [current.configRoot]}
          initialDirectory={createModalInitialDir}
          onClose={() => setCreateModalOpen(false)}
          onCreated={handleConfigCreated}
        />
      )}
    </div>
  )
}
