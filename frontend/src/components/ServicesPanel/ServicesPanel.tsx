import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/store/useAppStore'
import { serviceManager } from '@/services/services.service'
import { ServiceChip } from '@/components/ServiceChip'
import {
  AlertIcon,
  CheckIcon,
  ChevronDownIcon,
  FileIcon,
  PlayIcon,
  RefreshIcon,
  RestartIcon,
  SaveIcon,
  ServerIcon,
  StopIcon,
} from '@/components/Icons'
import { basename } from '@/lib/format'
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
    serviceManager
      .configList(profileId, selected)
      .then((list) => {
        if (!active) return
        setConfigs(list)
        if (list.length > 0) {
          void loadConfig(list[0].path)
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
  }, [profileId, selected, configNonce])

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
              {currentStatus?.state ?? 'unknown'}
            </span>
            <span className="mono">{current.serviceUnit}</span>
            {currentStatus?.pid && (
              <span className="mono meta-dim">pid {currentStatus.pid}</span>
            )}
            <span className="mono meta-dim service-status-path">
              {current.configFile}
            </span>
            {currentStatus?.detail && (
              <button
                className="text-button"
                onClick={() => setStatusDetailsOpen((value) => !value)}
              >
                {statusDetailsOpen ? 'Hide status' : 'Status details'}
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
            <aside className="config-list">
              <div className="section-title">
                <h3>Config files</h3>
                <button
                  className="icon-button"
                  onClick={() => setConfigNonce((value) => value + 1)}
                  title="Reload file list"
                >
                  <RefreshIcon size={13} />
                </button>
              </div>
              <div className="config-list__items">
                {configs.map((file) => (
                  <button
                    key={file.path}
                    className={`config-item ${configPath === file.path ? 'is-active' : ''}`}
                    onClick={() => void loadConfig(file.path)}
                    title={file.path}
                  >
                    <FileIcon size={13} />
                    <span className="config-item__name">{basename(file.path)}</span>
                    <span className="config-item__size">{file.size} B</span>
                  </button>
                ))}
                {configs.length === 0 && (
                  <p className="config-list__empty">No .conf files found.</p>
                )}
              </div>
            </aside>

            <section className="config-editor">
              <div className="config-editor__head">
                <span className="mono">{configPath || 'select a file'}</span>
                <div className="config-editor__actions">
                  {dirty && <span className="dirty-badge">modified</span>}
                  <button
                    className="top-action"
                    onClick={() => {
                      setContent(original)
                      setResult(null)
                      setResultExpanded(false)
                    }}
                    disabled={!dirty || saving}
                  >
                    Revert
                  </button>
                  <button
                    className="primary-button primary-button--small"
                    onClick={() => void saveConfig()}
                    disabled={!configPath || !dirty || saving}
                  >
                    <SaveIcon size={13} />
                    {saving ? 'Validating…' : 'Save & test'}
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
                <textarea
                  className="config-textarea"
                  value={configLoading ? 'loading…' : content}
                  onChange={(event) => setContent(event.target.value)}
                  spellCheck={false}
                  disabled={configLoading || !configPath}
                />
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
    </div>
  )
}
