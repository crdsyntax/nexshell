import { useEffect, useState } from 'react'
import { useAppStore } from '@/store/useAppStore'
import { monitorService } from '@/services/monitor.service'
import { processService } from '@/services/process.service'
import { openProcessTerminal } from '@/lib/actions'
import { LargeFilesModal } from '@/components/LargeFilesModal'
import {
  ActivityIcon,
  AlertIcon,
  ClockIcon,
  CpuIcon,
  FolderIcon,
  MemoryIcon,
  NetworkIcon,
  RefreshIcon,
  ServerIcon,
  TerminalIcon,
  XIcon,
} from '@/components/Icons'
import {
  formatBps,
  formatKb,
  formatUptime,
  percent,
  pressureLevel,
} from '@/lib/format'
import type { MetricsHistory, ProcessInfo } from '@/types'

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
          <Sparkline values={historyView.cpu} color="#5eead4" />
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
          <Sparkline values={historyView.mem} color="#38bdf8" />
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
            color="#a78bfa"
            secondaryColor="#38bdf8"
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
    </div>
  )
}
