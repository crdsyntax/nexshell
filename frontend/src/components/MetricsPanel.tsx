import { useEffect, useRef, useState } from 'react'
import { useAppStore } from '@/store/useAppStore'
import { monitorService } from '@/services/monitor.service'
import { processService } from '@/services/process.service'
import { pm2Service } from '@/services/pm2.service'
import { openProcessTerminal, openTerminalWithCommand } from '@/lib/actions'
import { LargeFilesModal } from '@/components/LargeFilesModal'
import {
  ActivityIcon,
  AlertIcon,
  ClockIcon,
  CpuIcon,
  FileIcon,
  FolderIcon,
  MemoryIcon,
  NetworkIcon,
  PlayIcon,
  RefreshIcon,
  RestartIcon,
  ServerIcon,
  StopIcon,
  TerminalIcon,
  TrashIcon,
  XIcon,
} from '@/components/Icons'
import {
  formatBps,
  formatKb,
  formatUptime,
  percent,
  pressureLevel,
} from '@/lib/format'
import type {
  MetricsHistory,
  NodeProcess,
  ProcessDetails,
  Pm2ActionKind,
  Pm2Logs,
  Pm2Process,
  Pm2Report,
  ProcessInfo,
} from '@/types'

interface MetricsPanelProps {
  profileId: string
}

function Sparkline({
  values,
  color,
  secondary,
  secondaryColor,
  max = 100,
}: {
  values: number[]
  color: string
  secondary?: number[]
  secondaryColor?: string
  max?: number
}) {
  const width = 240
  const height = 46
  if (values.length < 2) {
    return <div className="sparkline sparkline--empty">awaiting samples…</div>
  }
  const scale = Math.max(max, ...values, ...(secondary ?? []), 0.001)
  const toPoints = (series: number[]) =>
    series
      .map((value, index) => {
        const x = (index / Math.max(1, series.length - 1)) * width
        const y = height - Math.min(1, value / scale) * (height - 4) - 2
        return `${x.toFixed(1)},${y.toFixed(1)}`
      })
      .join(' ')

  const points = toPoints(values)
  const area = `0,${height} ${points} ${width},${height}`

  return (
    <svg className="sparkline" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
      <polygon points={area} fill={`${color}22`} stroke="none" />
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth="1.6"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {secondary && secondary.length > 1 && (
        <polyline
          points={toPoints(secondary)}
          fill="none"
          stroke={secondaryColor ?? color}
          strokeWidth="1.2"
          strokeOpacity="0.75"
          strokeDasharray="3 3"
          strokeLinejoin="round"
          strokeLinecap="round"
        />
      )}
    </svg>
  )
}

function Meter({ value, level }: { value: number; level: 'ok' | 'warn' | 'critical' }) {
  return (
    <div className="meter">
      <div
        className={`meter__fill meter__fill--${level}`}
        style={{ width: `${Math.min(100, Math.max(0, value))}%` }}
      />
    </div>
  )
}

export function MetricsPanel({ profileId }: MetricsPanelProps) {
  const snapshot = useAppStore((state) => state.metrics[profileId])
  const history = useAppStore((state) => state.history[profileId])
  const metricsError = useAppStore((state) => state.metricsErrors[profileId])
  const server = useAppStore((state) => state.servers[profileId])
  const profiles = useAppStore((state) => state.profiles)
  const setMetricsError = useAppStore((state) => state.setMetricsError)
  const pushToast = useAppStore((state) => state.pushToast)
  const [interval, setIntervalMs] = useState(2_000)
  const [killTarget, setKillTarget] = useState<ProcessInfo | null>(null)
  const [killSignal, setKillSignal] = useState<'TERM' | 'INT' | 'KILL'>('TERM')
  const [killBusy, setKillBusy] = useState(false)
  const [killError, setKillError] = useState<string | null>(null)

  const [nodeProcesses, setNodeProcesses] = useState<NodeProcess[]>([])
  const [nodeLoading, setNodeLoading] = useState(false)
  const [nodeError, setNodeError] = useState<string | null>(null)

  const [pm2, setPm2] = useState<Pm2Report | null>(null)
  const [pm2Loading, setPm2Loading] = useState(false)
  const [pm2Error, setPm2Error] = useState<string | null>(null)
  const [pm2Target, setPm2Target] = useState<{
    process: Pm2Process
    action: Pm2ActionKind
  } | null>(null)
  const [pm2Busy, setPm2Busy] = useState(false)
  const [pm2Result, setPm2Result] = useState<string | null>(null)
  const [logsTarget, setLogsTarget] = useState<Pm2Process | null>(null)
  const [logs, setLogs] = useState<Pm2Logs | null>(null)
  const [logsLoading, setLogsLoading] = useState(false)
  const [logsTab, setLogsTab] = useState<'stdout' | 'stderr'>('stdout')
  const [logsLines, setLogsLines] = useState(200)
  const [injectCommand, setInjectCommand] = useState('')
  const [stalled, setStalled] = useState(false)
  const lastUpdateRef = useRef(Date.now())

  const [monitorTarget, setMonitorTarget] = useState<Pm2Process | null>(null)
  const [details, setDetails] = useState<ProcessDetails | null>(null)
  const [detailsLoading, setDetailsLoading] = useState(false)
  const [detailsError, setDetailsError] = useState<string | null>(null)
  const [largeFilesOpen, setLargeFilesOpen] = useState(false)
  const [nonce, setNonce] = useState(0)
  const [starting, setStarting] = useState(true)

  const profile = profiles.find((item) => item.id === profileId)

  const openLocation = (process: ProcessInfo) => {
    if (!profile) {
      pushToast('error', 'Select a profile before opening a process directory.')
      return
    }
    openProcessTerminal(profile, process.pid)
  }

  const confirmKill = async () => {
    if (!killTarget) return
    setKillBusy(true)
    setKillError(null)
    try {
      const result = await processService.kill(profileId, killTarget.pid, killSignal)
      pushToast(
        'success',
        result.output || `SIG${killSignal} sent to PID ${killTarget.pid}`,
      )
      setKillTarget(null)
    } catch (error) {
      setKillError(String(error))
    } finally {
      setKillBusy(false)
    }
  }

  const loadNode = async () => {
    setNodeLoading(true)
    setNodeError(null)
    try {
      setNodeProcesses(await processService.nodeProcesses(profileId))
    } catch (error) {
      setNodeError(String(error))
    } finally {
      setNodeLoading(false)
    }
  }

  const loadPm2 = async () => {
    setPm2Loading(true)
    setPm2Error(null)
    try {
      setPm2(await pm2Service.list(profileId))
    } catch (error) {
      const message = String(error)
      setPm2Error(message)
      pushToast('error', message)
    } finally {
      setPm2Loading(false)
    }
  }

  useEffect(() => {
    void loadPm2()
    void loadNode()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId])

  const snapshotStamp = useAppStore(
    (state) => state.metrics[profileId]?.timestamp ?? null,
  )

  useEffect(() => {
    lastUpdateRef.current = Date.now()
    setStalled(false)
  }, [snapshotStamp])

  // Watchdog: if the backend watcher dies or the SSH link stalls, the panel used to
  // freeze on the last sample. Restart the collector when no update arrives.
  useEffect(() => {
    const timer = window.setInterval(() => {
      if (Date.now() - lastUpdateRef.current < 12_000) return
      lastUpdateRef.current = Date.now()
      setStalled(true)
      void monitorService
        .stop(profileId)
        .then(() => monitorService.start(profileId, interval))
        .catch(() => undefined)
    }, 5_000)
    return () => window.clearInterval(timer)
  }, [profileId, interval])

  const runPm2Action = async () => {
    if (!pm2Target) return
    setPm2Busy(true)
    setPm2Result(null)
    try {
      const output = await pm2Service.action(
        profileId,
        pm2Target.process.id,
        pm2Target.action,
      )
      pushToast('success', output || `pm2 ${pm2Target.action} ok`)
      setPm2Target(null)
      await loadPm2()
    } catch (error) {
      setPm2Result(String(error))
    } finally {
      setPm2Busy(false)
    }
  }

  const openMonitor = async (process: Pm2Process) => {
    setMonitorTarget(process)
    setDetails(null)
    setDetailsError(null)
    if (process.pid === null) {
      setDetailsError('La app está detenida: no hay PID que inspeccionar.')
      return
    }
    setDetailsLoading(true)
    try {
      setDetails(await processService.details(profileId, process.pid))
    } catch (error) {
      setDetailsError(String(error))
    } finally {
      setDetailsLoading(false)
    }
  }

  const refreshMonitor = async () => {
    if (!monitorTarget?.pid) return
    setDetailsLoading(true)
    setDetailsError(null)
    try {
      setDetails(await processService.details(profileId, monitorTarget.pid))
    } catch (error) {
      setDetailsError(String(error))
    } finally {
      setDetailsLoading(false)
    }
  }

  const openLogs = async (process: Pm2Process) => {
    setLogsTarget(process)
    setLogs(null)
    setLogsTab('stdout')
    await loadLogs(process, logsLines)
  }

  const loadLogs = async (process: Pm2Process, lines: number) => {
    setLogsLoading(true)
    setPm2Result(null)
    try {
      setLogs(await pm2Service.logs(profileId, process.id, lines))
    } catch (error) {
      setPm2Result(String(error))
    } finally {
      setLogsLoading(false)
    }
  }

  useEffect(() => {
    let active = true
    setStarting(true)
    monitorService
      .start(profileId, interval)
      .then(() => {
        if (!active) {
          void monitorService.stop(profileId)
          return null
        }
        return monitorService.snapshot(profileId)
      })
      .then((sample) => {
        if (active && sample) {
          useAppStore.getState().setMetrics(profileId, sample)
        }
      })
      .catch((error) => {
        if (active) setMetricsError(profileId, String(error))
      })
      .finally(() => {
        if (active) setStarting(false)
      })

    return () => {
      active = false
      void monitorService.stop(profileId)
    }
    // nonce forces a collector restart when the user presses refresh
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [profileId, interval, nonce])

  const cpu = snapshot?.cpuTotal ?? 0
  const memPercent = percent(snapshot?.memUsedKb ?? 0, snapshot?.memTotalKb ?? 0)
  const swapPercent = percent(snapshot?.swapUsedKb ?? 0, snapshot?.swapTotalKb ?? 0)
  const diskPercent = percent(snapshot?.diskUsedKb ?? 0, snapshot?.diskTotalKb ?? 0)

  if (!snapshot) {
    return (
      <div className="panel panel--centered">
        <div className="panel-loading">
          <span className="spinner" />
          <strong>Collecting first sample from {profile?.name ?? 'host'}…</strong>
          <p>Reading /proc, disk and process table over SSH.</p>
          {metricsError && (
            <div className="inline-alert inline-alert--error">
              <AlertIcon size={15} />
              <span>{metricsError}</span>
            </div>
          )}
        </div>
      </div>
    )
  }

  const historyView: MetricsHistory = history ?? { cpu: [], mem: [], rx: [], tx: [] }
  const maxNetwork = Math.max(
    ...historyView.rx,
    ...historyView.tx,
    1024,
  )

  return (
    <div className="panel">
      <div className="panel__header">
        <div>
          <div className="panel__eyebrow">
            <ActivityIcon size={14} /> live performance
          </div>
          <h2>
            {snapshot.hostname}
            <span className="panel__sub">{snapshot.kernel}</span>
          </h2>
          <p className="panel__description">
            {server?.osName ?? profile?.name} · sampled over SSH every{' '}
            {interval / 1000}s
          </p>
        </div>
        <div className="panel__actions">
          {stalled && (
            <span className="stall-badge">
              <RefreshIcon size={12} className="spin" /> reconectando
            </span>
          )}
          <label className="select-inline">
            <span>interval</span>
            <select
              value={interval}
              onChange={(event) => setIntervalMs(Number(event.target.value))}
            >
              <option value={1000}>1s</option>
              <option value={2000}>2s</option>
              <option value={5000}>5s</option>
              <option value={10000}>10s</option>
            </select>
          </label>
          <button
            className="top-action"
            onClick={() => setNonce((value) => value + 1)}
            disabled={starting}
          >
            <RefreshIcon size={14} className={starting ? 'spin' : ''} /> Refresh
          </button>
        </div>
      </div>

      {metricsError && (
        <div className="inline-alert inline-alert--error">
          <AlertIcon size={15} />
          <span>{metricsError}</span>
        </div>
      )}

      <div className="metric-grid">
        <article className="metric-card metric-card--cpu">
          <header>
            <span>
              <CpuIcon size={15} /> CPU
            </span>
            <strong className={`value value--${pressureLevel(cpu)}`}>
              {cpu.toFixed(1)}%
            </strong>
          </header>
          <Sparkline values={historyView.cpu} color="#fbbf24" />
          <footer>{snapshot.cores.length} logical cores</footer>
        </article>

        <article className="metric-card">
          <header>
            <span>
              <MemoryIcon size={15} /> Memory
            </span>
            <strong className={`value value--${pressureLevel(memPercent)}`}>
              {memPercent.toFixed(0)}%
            </strong>
          </header>
          <Meter value={memPercent} level={pressureLevel(memPercent)} />
          <div className="metric-card__split">
            <span>{formatKb(snapshot.memUsedKb)} used</span>
            <span>{formatKb(snapshot.memTotalKb)} total</span>
          </div>
          <Sparkline values={historyView.mem} color="#a3e635" />
          <footer>
            {formatKb(snapshot.memAvailableKb)} available · swap{' '}
            {formatKb(snapshot.swapUsedKb)}
            {snapshot.swapTotalKb > 0
              ? ` / ${formatKb(snapshot.swapTotalKb)} (${swapPercent.toFixed(0)}%)`
              : ' disabled'}
          </footer>
        </article>

        <article className="metric-card">
          <header>
            <span>
              <ServerIcon size={15} /> Load average
            </span>
            <strong className="value">{snapshot.load1.toFixed(2)}</strong>
          </header>
          <div className="load-row">
            <div>
              <span>1 min</span>
              <strong>{snapshot.load1.toFixed(2)}</strong>
            </div>
            <div>
              <span>5 min</span>
              <strong>{snapshot.load5.toFixed(2)}</strong>
            </div>
            <div>
              <span>15 min</span>
              <strong>{snapshot.load15.toFixed(2)}</strong>
            </div>
          </div>
          <footer>
            <ClockIcon size={12} /> uptime {formatUptime(snapshot.uptimeSecs)}
          </footer>
        </article>

        <article className="metric-card">
          <header>
            <span>
              <NetworkIcon size={15} /> Network
            </span>
            <strong className="value value--net">
              ↓ {formatBps(snapshot.netRxBps)}
            </strong>
          </header>
          <div className="net-row">
            <span className="net-row__rx">↓ {formatBps(snapshot.netRxBps)}</span>
            <span className="net-row__tx">↑ {formatBps(snapshot.netTxBps)}</span>
          </div>
          <Sparkline
            values={historyView.rx}
            secondary={historyView.tx}
            color="#a3e635"
            secondaryColor="#a3e635"
            max={maxNetwork}
          />
          <footer>rx solid · tx dashed</footer>
        </article>

        <article className="metric-card">
          <header>
            <span>
              <ServerIcon size={15} /> Root filesystem
            </span>
            <strong className={`value value--${pressureLevel(diskPercent)}`}>
              {diskPercent.toFixed(0)}%
            </strong>
          </header>
          <Meter value={diskPercent} level={pressureLevel(diskPercent)} />
          <div className="metric-card__split">
            <span>{formatKb(snapshot.diskUsedKb)} used</span>
            <span>{formatKb(snapshot.diskTotalKb)} total</span>
          </div>
          <footer>{formatKb(snapshot.diskTotalKb - snapshot.diskUsedKb)} free</footer>
          <button
            className="metric-card__button"
            onClick={() => setLargeFilesOpen(true)}
            disabled={!profile}
          >
            <FolderIcon size={13} /> Review largest files
          </button>
        </article>
      </div>

      <section className="cores-section">
        <div className="section-title">
          <h3>Per-core pressure</h3>
          <span>{snapshot.cores.length} cores</span>
        </div>
        <div className="core-grid">
          {snapshot.cores.map((core) => (
            <div className="core-card" key={core.name}>
              <div className="core-card__head">
                <span>cpu{core.name}</span>
                <strong>{core.usage.toFixed(0)}%</strong>
              </div>
              <Meter value={core.usage} level={pressureLevel(core.usage)} />
            </div>
          ))}
        </div>
      </section>

      <div className="monitor-columns">
        <section className="process-section">
          <div className="section-title">
            <h3>Top processes</h3>
          <span>sorted by CPU · sampled {new Date(snapshot.timestamp * 1000).toLocaleTimeString()}</span>
        </div>
        <div className="process-table">
          <div className="process-table__head">
            <span>PID</span>
            <span>USER</span>
            <span>CPU%</span>
            <span>MEM%</span>
            <span>RSS</span>
            <span>COMMAND</span>
            <span className="process-table__actions-head">ACTIONS</span>
          </div>
          {snapshot.processes.map((process) => (
            <div className="process-table__row" key={process.pid}>
              <span className="mono">{process.pid}</span>
              <span>{process.user}</span>
              <span className={`mono ${process.cpu > 50 ? 'is-hot' : ''}`}>
                {process.cpu.toFixed(1)}
              </span>
              <span className="mono">{process.mem.toFixed(1)}</span>
              <span className="mono">{formatKb(process.rssKb)}</span>
              <span className="mono process-table__cmd" title={process.command}>
                {process.command}
              </span>
              <div className="process-actions">
                <button
                  className="icon-button"
                  title="Open the process working directory in a new terminal"
                  onClick={() => openLocation(process)}
                  disabled={!profile}
                >
                  <TerminalIcon size={13} />
                </button>
                <button
                  className="icon-button is-danger"
                  title={
                    process.pid <= 1
                      ? 'PID 1 cannot be killed'
                      : `Send a signal to PID ${process.pid}`
                  }
                  disabled={process.pid <= 1}
                  onClick={() => {
                    setKillTarget(process)
                    setKillSignal('TERM')
                    setKillError(null)
                  }}
                >
                  <XIcon size={13} />
                </button>
              </div>
            </div>
          ))}
          {snapshot.processes.length === 0 && (
            <div className="process-table__empty">no process data returned</div>
          )}
        </div>
        </section>

        <section className="pm2-section">
        <div className="section-title">
          <h3>PM2 processes</h3>
          <div className="pm2-title-actions">
            <span>
              {pm2?.available
                ? `${pm2.processes.length} apps · ${pm2.binary || 'pm2'}`
                : pm2
                  ? 'pm2 not detected'
                  : 'not loaded'}
            </span>
            <button
              className="top-action"
              onClick={() => void loadPm2()}
              disabled={pm2Loading}
            >
              <RefreshIcon size={13} className={pm2Loading ? 'spin' : ''} /> Refresh
            </button>
          </div>
        </div>

        {pm2Error && (
          <div className="inline-alert inline-alert--error">
            <AlertIcon size={15} />
            <span>{pm2Error}</span>
          </div>
        )}

        {pm2?.available && (
          <div className="pm2-cards">
            {pm2.processes.map((process) => (
              <article className="pm2-card" key={process.id}>
                <header>
                  <span className="pm2-card__id">#{process.id}</span>
                  <strong
                    className="pm2-card__name"
                    title={`${process.script || process.name}\n${process.cwd}`}
                  >
                    {process.name}
                  </strong>
                  {process.namespace !== 'default' && process.namespace ? (
                    <span className="pm2-card__ns">{process.namespace}</span>
                  ) : null}
                  <span className={`pm2-status is-${process.status}`}>{process.status}</span>
                </header>
                <div className="pm2-card__grid">
                  <span>Uptime</span>
                  <strong className="mono">
                    {process.uptimeMs && process.status === 'online'
                      ? formatUptime(Math.max(0, (Date.now() - process.uptimeMs) / 1000))
                      : '—'}
                  </strong>
                  <span>Restarts</span>
                  <strong className="mono">{process.restarts}</strong>
                  <span>Memory</span>
                  <strong className="mono">
                    {formatKb(Math.round(process.memory / 1024))}
                  </strong>
                  <span>CPU</span>
                  <strong className="mono">{process.cpu.toFixed(1)}%</strong>
                </div>
                <footer>
                  <span className="pm2-card__path" title={process.cwd}>
                    {process.script ? process.script.split('/').pop() : '—'}
                  </span>
                  <div className="pm2-card__actions">
                    {process.status === 'online' ? (
                      <button
                        className="icon-button"
                        title="Stop this app"
                        onClick={() => {
                          setPm2Result(null)
                          setPm2Target({ process, action: 'stop' })
                        }}
                      >
                        <StopIcon size={13} />
                      </button>
                    ) : (
                      <button
                        className="icon-button"
                        title="Start this app"
                        onClick={() => {
                          setPm2Result(null)
                          setPm2Target({ process, action: 'start' })
                        }}
                      >
                        <PlayIcon size={13} />
                      </button>
                    )}
                    <button
                      className="icon-button"
                      title="Restart this app"
                      onClick={() => {
                        setPm2Result(null)
                        setPm2Target({ process, action: 'restart' })
                      }}
                    >
                      <RestartIcon size={13} />
                    </button>
                    <button
                      className="icon-button"
                      title="Monitor this process"
                      onClick={() => void openMonitor(process)}
                      disabled={process.pid === null}
                    >
                      <ActivityIcon size={13} />
                    </button>
                    <button
                      className="icon-button"
                      title="Open out/error logs"
                      onClick={() => void openLogs(process)}
                    >
                      <FileIcon size={13} />
                    </button>
                    <button
                      className="icon-button is-danger"
                      title="Remove this app from the pm2 list"
                      onClick={() => {
                        setPm2Result(null)
                        setPm2Target({ process, action: 'delete' })
                      }}
                    >
                      <TrashIcon size={13} />
                    </button>
                  </div>
                </footer>
              </article>
            ))}
            {pm2.processes.length === 0 && (
              <div className="process-table__empty">pm2 has no processes</div>
            )}
          </div>
        )}

        {pm2?.available && (
          <div className="pm2-inject">
            <div className="pm2-inject__label">
              <TerminalIcon size={12} /> TERMINAL INJECTION
            </div>
            <form
              className="pm2-inject__form"
              onSubmit={(event) => {
                event.preventDefault()
                const command = injectCommand.trim()
                if (!command || !profile) return
                openTerminalWithCommand(profile, command)
                setInjectCommand('')
                pushToast('success', `Running in a new terminal: ${command}`)
              }}
            >
              <span className="pm2-inject__prompt">$</span>
              <input
                value={injectCommand}
                onChange={(event) => setInjectCommand(event.target.value)}
                placeholder="pm2 restart all"
                spellCheck={false}
                aria-label="Command to run in a new terminal"
              />
              <button
                type="submit"
                className="pm2-inject__send"
                disabled={!injectCommand.trim() || !profile}
                title="Open a terminal and run this command"
              >
                <PlayIcon size={13} />
              </button>
            </form>
          </div>
        )}

        {pm2 && !pm2.available && (
          <div className="process-table__empty">
            pm2 is not installed for this SSH user (checked PATH, /usr/local/bin and
            nvm).
          </div>
        )}
        </section>
      </div>

      <section className="node-section">
        <div className="section-title">
          <h3>Node processes</h3>
          <div className="pm2-title-actions">
            <span>{nodeProcesses.length} running</span>
            <button
              className="top-action"
              onClick={() => void loadNode()}
              disabled={nodeLoading}
            >
              <RefreshIcon size={13} className={nodeLoading ? 'spin' : ''} /> Refresh
            </button>
          </div>
        </div>
        {nodeError && (
          <div className="inline-alert inline-alert--error">
            <AlertIcon size={15} />
            <span>{nodeError}</span>
          </div>
        )}
        <div className="process-table node-table">
          <div className="process-table__head">
            <span>PID</span>
            <span>USER</span>
            <span>CPU%</span>
            <span>MEM%</span>
            <span>RSS</span>
            <span>UPTIME</span>
            <span>COMMAND</span>
          </div>
          {nodeProcesses.map((process) => (
            <div className="process-table__row" key={process.pid}>
              <span className="mono">{process.pid}</span>
              <span>{process.user}</span>
              <span className={`mono ${process.cpu > 50 ? 'is-hot' : ''}`}>
                {process.cpu.toFixed(1)}
              </span>
              <span className="mono">{process.mem.toFixed(1)}</span>
              <span className="mono">{formatKb(process.rssKb)}</span>
              <span className="mono">{formatUptime(process.elapsedSecs)}</span>
              <span className="mono process-table__cmd" title={process.command}>
                {process.command}
              </span>
            </div>
          ))}
          {nodeProcesses.length === 0 && !nodeLoading && (
            <div className="process-table__empty">no node processes found</div>
          )}
        </div>
      </section>

      {profile && (
        <LargeFilesModal
          open={largeFilesOpen}
          profile={profile}
          onClose={() => setLargeFilesOpen(false)}
        />
      )}

      {killTarget && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !killBusy) setKillTarget(null)
          }}
        >
          <div className="modal modal--compact" role="dialog" aria-modal="true">
            <header className="modal__header">
              <div>
                <h2>Kill process</h2>
                <p>Send a signal to PID {killTarget.pid}.</p>
              </div>
              <button
                className="icon-button"
                onClick={() => setKillTarget(null)}
                disabled={killBusy}
                title="Close"
              >
                <XIcon size={16} />
              </button>
            </header>
            <div className="modal__body">
              <div className="process-summary">
                <div>
                  <span>PID</span>
                  <strong className="mono">{killTarget.pid}</strong>
                </div>
                <div>
                  <span>User</span>
                  <strong>{killTarget.user}</strong>
                </div>
                <div>
                  <span>CPU</span>
                  <strong className="mono">{killTarget.cpu.toFixed(1)}%</strong>
                </div>
                <div>
                  <span>Memory</span>
                  <strong className="mono">{killTarget.mem.toFixed(1)}%</strong>
                </div>
                <code>{killTarget.command}</code>
              </div>

              <label className="field">
                <span>Signal</span>
                <select
                  value={killSignal}
                  onChange={(event) =>
                    setKillSignal(event.target.value as 'TERM' | 'INT' | 'KILL')
                  }
                  disabled={killBusy}
                >
                  <option value="TERM">SIGTERM — graceful termination (recommended)</option>
                  <option value="INT">SIGINT — interrupt (Ctrl+C)</option>
                  <option value="KILL">SIGKILL — force kill (cannot be caught)</option>
                </select>
              </label>
              <p className="field-hint">
                SIGTERM gives the process a chance to clean up. SIGKILL terminates it
                immediately and may lose unsaved data.
              </p>

              {killError && (
                <div className="inline-alert inline-alert--error">
                  <AlertIcon size={15} />
                  <span>{killError}</span>
                </div>
              )}
            </div>
            <footer className="modal__footer">
              <button
                className="ghost-button"
                onClick={() => setKillTarget(null)}
                disabled={killBusy}
              >
                Cancel
              </button>
              <button
                className="danger-button"
                onClick={() => void confirmKill()}
                disabled={killBusy}
              >
                {killBusy ? 'Sending…' : `Send SIG${killSignal}`}
              </button>
            </footer>
          </div>
        </div>
      )}

      {pm2Target && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !pm2Busy) setPm2Target(null)
          }}
        >
          <div className="modal modal--compact" role="dialog" aria-modal="true">
            <header className="modal__header">
              <div>
                <h2>
                  pm2 {pm2Target.action}: {pm2Target.process.name}
                </h2>
                <p>
                  id {pm2Target.process.id} · {pm2Target.process.mode} ·{' '}
                  {pm2Target.process.status}
                </p>
              </div>
              <button
                className="icon-button"
                onClick={() => setPm2Target(null)}
                disabled={pm2Busy}
                title="Close"
              >
                <XIcon size={16} />
              </button>
            </header>
            <div className="modal__body">
              <div className="process-summary">
                <div>
                  <span>Script</span>
                  <strong className="mono">{pm2Target.process.script || '—'}</strong>
                </div>
                <div>
                  <span>Working dir</span>
                  <strong className="mono">{pm2Target.process.cwd || '—'}</strong>
                </div>
                <div>
                  <span>Restarts</span>
                  <strong className="mono">{pm2Target.process.restarts}</strong>
                </div>
                <div>
                  <span>Memory</span>
                  <strong className="mono">
                    {formatKb(Math.round(pm2Target.process.memory / 1024))}
                  </strong>
                </div>
              </div>
              <div
                className={`inline-alert ${
                  pm2Target.action === 'delete' ? 'inline-alert--error' : 'inline-alert--warn'
                }`}
              >
                <AlertIcon size={15} />
                <span>
                  {pm2Target.action === 'delete'
                    ? 'Delete removes the app from the pm2 list (it will not start on reboot). The application files are not touched.'
                    : pm2Target.action === 'stop'
                      ? 'Stop keeps the app in the list but takes it offline until you start it again.'
                      : `pm2 ${pm2Target.action} will interrupt active connections while the app restarts.`}
                </span>
              </div>
              {pm2Result && (
                <div className="inline-alert inline-alert--error">
                  <AlertIcon size={15} />
                  <span>{pm2Result}</span>
                </div>
              )}
            </div>
            <footer className="modal__footer">
              <button
                className="ghost-button"
                onClick={() => setPm2Target(null)}
                disabled={pm2Busy}
              >
                Cancel
              </button>
              <button
                className={pm2Target.action === 'delete' ? 'danger-button' : 'primary-button'}
                onClick={() => void runPm2Action()}
                disabled={pm2Busy}
              >
                {pm2Busy ? 'Applying…' : `pm2 ${pm2Target.action}`}
              </button>
            </footer>
          </div>
        </div>
      )}

      {logsTarget && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !logsLoading) setLogsTarget(null)
          }}
        >
          <div className="modal modal--logs" role="dialog" aria-modal="true">
            <header className="modal__header">
              <div>
                <h2>
                  pm2 logs · {logsTarget.name}
                  <span className="panel__sub">id {logsTarget.id}</span>
                </h2>
                <p>
                  {logsTab === 'stdout' ? logs?.outPath : logs?.errPath || 'log path'}
                </p>
              </div>
              <button
                className="icon-button"
                onClick={() => setLogsTarget(null)}
                disabled={logsLoading}
                title="Close"
              >
                <XIcon size={16} />
              </button>
            </header>
            <div className="modal__body pm2-logs-body">
              <div className="pm2-logs-toolbar">
                <div className="security-tabs">
                  <button
                    className={logsTab === 'stdout' ? 'is-active' : ''}
                    onClick={() => setLogsTab('stdout')}
                  >
                    stdout
                  </button>
                  <button
                    className={logsTab === 'stderr' ? 'is-active' : ''}
                    onClick={() => setLogsTab('stderr')}
                  >
                    stderr
                  </button>
                </div>
                <label className="select-inline">
                  <span>lines</span>
                  <select
                    value={logsLines}
                    onChange={(event) => {
                      const value = Number(event.target.value)
                      setLogsLines(value)
                      if (logsTarget) void loadLogs(logsTarget, value)
                    }}
                  >
                    <option value={100}>100</option>
                    <option value={200}>200</option>
                    <option value={500}>500</option>
                    <option value={1000}>1000</option>
                  </select>
                </label>
                <button
                  className="top-action"
                  onClick={() => logsTarget && void loadLogs(logsTarget, logsLines)}
                  disabled={logsLoading}
                >
                  <RefreshIcon size={13} className={logsLoading ? 'spin' : ''} /> Reload
                </button>
              </div>
              {pm2Result && (
                <div className="inline-alert inline-alert--error">
                  <AlertIcon size={15} />
                  <span>{pm2Result}</span>
                </div>
              )}
              <pre className="pm2-log-pre">
                {logsLoading
                  ? 'reading logs…'
                  : logsTab === 'stdout'
                    ? logs?.stdout || '(empty)'
                    : logs?.stderr || '(empty)'}
              </pre>
            </div>
            <footer className="modal__footer">
              <span className="field-hint">
                Tail leído directamente de {logs?.outPath ? 'los archivos de pm2' : 'pm2'}.
              </span>
              <button className="ghost-button" onClick={() => setLogsTarget(null)}>
                Close
              </button>
            </footer>
          </div>
        </div>
      )}

      {monitorTarget && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !detailsLoading) {
              setMonitorTarget(null)
              setDetails(null)
            }
          }}
        >
          <div className="modal modal--compact" role="dialog" aria-modal="true">
            <header className="modal__header">
              <div>
                <h2>
                  Monitor · {monitorTarget.name}
                  <span className="panel__sub">id {monitorTarget.id}</span>
                </h2>
                <p>Datos de /proc en el servidor remoto.</p>
              </div>
              <button
                className="icon-button"
                onClick={() => setMonitorTarget(null)}
                disabled={detailsLoading}
                title="Cerrar"
              >
                <XIcon size={16} />
              </button>
            </header>
            <div className="modal__body">
              {detailsLoading && <div className="process-table__empty">leyendo proceso…</div>}
              {detailsError && (
                <div className="inline-alert inline-alert--error">
                  <AlertIcon size={15} />
                  <span>{detailsError}</span>
                </div>
              )}
              {details && (
                <div className="monitor-details">
                  <div><span>PID</span><strong className="mono">{details.pid}</strong></div>
                  <div><span>Usuario</span><strong className="mono">{details.user}</strong></div>
                  <div><span>Estado</span><strong className="mono">{details.state}</strong></div>
                  <div><span>CPU</span><strong className="mono">{details.cpu.toFixed(1)}%</strong></div>
                  <div><span>Memoria</span><strong className="mono">{details.mem.toFixed(1)}%</strong></div>
                  <div><span>RSS</span><strong className="mono">{formatKb(details.rssKb)}</strong></div>
                  <div><span>Hilos</span><strong className="mono">{details.threads}</strong></div>
                  <div><span>FDs</span><strong className="mono">{details.openFiles}</strong></div>
                  <div className="monitor-details__wide">
                    <span>Inicio</span><strong className="mono">{details.started}</strong>
                  </div>
                  <div className="monitor-details__wide">
                    <span>Executable</span><strong className="mono">{details.exe || '—'}</strong>
                  </div>
                  <div className="monitor-details__wide">
                    <span>Working dir</span><strong className="mono">{details.cwd || '—'}</strong>
                  </div>
                  <div className="monitor-details__wide">
                    <span>Cmdline</span><strong className="mono">{details.command}</strong>
                  </div>
                </div>
              )}
            </div>
            <footer className="modal__footer">
              <button
                className="ghost-button"
                onClick={() => {
                  if (profile && monitorTarget.pid) {
                    setMonitorTarget(null)
                    openProcessTerminal(profile, monitorTarget.pid)
                  }
                }}
                disabled={!monitorTarget.pid}
              >
                <TerminalIcon size={13} /> Abrir terminal
              </button>
              <button
                className="ghost-button"
                onClick={() => void refreshMonitor()}
                disabled={detailsLoading || !monitorTarget.pid}
              >
                <RefreshIcon size={13} className={detailsLoading ? 'spin' : ''} /> Actualizar
              </button>
              <button className="primary-button" onClick={() => setMonitorTarget(null)}>
                Cerrar
              </button>
            </footer>
          </div>
        </div>
      )}
    </div>
  )
}
