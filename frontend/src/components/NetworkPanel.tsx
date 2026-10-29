import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/store/useAppStore'
import { networkService } from '@/services/network.service'
import {
  AlertIcon,
  NetworkIcon,
  RefreshIcon,
  SearchIcon,
  ShieldIcon,
} from '@/components/Icons'
import type { NetworkReport } from '@/types'

interface NetworkPanelProps {
  profileId: string
}

export function NetworkPanel({ profileId }: NetworkPanelProps) {
  const profiles = useAppStore((state) => state.profiles)
  const profile = profiles.find((item) => item.id === profileId)
  const pushToast = useAppStore((state) => state.pushToast)
  const [report, setReport] = useState<NetworkReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setReport(await networkService.scan(profileId))
    } catch (err) {
      const message = String(err)
      setError(message)
      pushToast('error', message)
    } finally {
      setLoading(false)
    }
  }, [profileId, pushToast])

  useEffect(() => {
    void load()
  }, [load])

  const term = search.trim().toLowerCase()
  const listening = useMemo(() => {
    if (!report) return []
    if (!term) return report.listening
    return report.listening.filter((port) =>
      [port.protocol, port.local, String(port.port), port.process, port.pid ?? '']
        .join(' ')
        .toLowerCase()
        .includes(term),
    )
  }, [report, term])

  const connections = useMemo(() => {
    if (!report) return []
    if (!term) return report.connections
    return report.connections.filter((connection) =>
      [
        connection.protocol,
        connection.state,
        connection.local,
        connection.remote,
        connection.process,
        connection.pid ?? '',
      ]
        .join(' ')
        .toLowerCase()
        .includes(term),
    )
  }, [report, term])

  const publicPorts = report?.listening.filter((port) => port.public).length ?? 0

  return (
    <div className="panel network-panel">
      <div className="panel__header">
        <div>
          <div className="panel__eyebrow">
            <NetworkIcon size={14} /> network surface
          </div>
          <h2>
            Network
            <span className="panel__sub">{profile?.name ?? profileId}</span>
          </h2>
          <p className="panel__description">
            Listening sockets and established connections, sampled on demand over SSH.
          </p>
        </div>
        <div className="panel__actions">
          <div className="db-search">
            <SearchIcon size={14} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="Filter port, process or IP…"
              spellCheck={false}
            />
          </div>
          <button className="top-action" onClick={() => void load()} disabled={loading}>
            <RefreshIcon size={13} className={loading ? 'spin' : ''} /> Refresh
          </button>
        </div>
      </div>

      {error && (
        <div className="inline-alert inline-alert--error">
          <AlertIcon size={15} />
          <span>{error}</span>
        </div>
      )}

      {report && (
        <>
          <div className="network-summary">
            <div>
              <span>hostname</span>
              <strong className="mono">{report.hostname}</strong>
            </div>
            <div>
              <span>listening</span>
              <strong className="mono">{report.listening.length}</strong>
            </div>
            <div className={publicPorts > 0 ? 'is-warn' : 'is-ok'}>
              <span>public sockets</span>
              <strong className="mono">{publicPorts}</strong>
            </div>
            <div>
              <span>established</span>
              <strong className="mono">{report.connections.length}</strong>
            </div>
            <div>
              <span>sampled</span>
              <strong className="mono">
                {new Date(report.generatedAt * 1000).toLocaleTimeString()}
              </strong>
            </div>
          </div>

          <section className="network-block">
            <header>
              <h3>
                <NetworkIcon size={13} /> Listening sockets
              </h3>
              <span>{listening.length} shown</span>
            </header>
            <div className="network-table">
              <div className="network-row network-row--head">
                <span>PROTO</span>
                <span>LOCAL</span>
                <span>PORT</span>
                <span>PROCESS</span>
                <span>PID</span>
                <span>EXPOSURE</span>
              </div>
              {listening.map((port) => (
                <div className="network-row" key={`${port.protocol}-${port.local}-${port.pid}`}>
                  <span className="mono">{port.protocol}</span>
                  <span className="mono network-address">{port.ip}</span>
                  <span className="mono">{port.port}</span>
                  <span className="mono network-process">{port.process || '—'}</span>
                  <span className="mono">{port.pid ?? '—'}</span>
                  <span>
                    {port.public ? (
                      <span className="network-badge is-public">
                        <AlertIcon size={11} /> all interfaces
                      </span>
                    ) : (
                      <span className="network-badge is-local">
                        <ShieldIcon size={11} /> loopback
                      </span>
                    )}
                  </span>
                </div>
              ))}
              {listening.length === 0 && (
                <div className="process-table__empty">no listening sockets matched</div>
              )}
            </div>
          </section>

          <section className="network-block">
            <header>
              <h3>
                <NetworkIcon size={13} /> Established connections
              </h3>
              <span>{connections.length} shown</span>
            </header>
            <div className="network-table network-table--connections">
              <div className="network-row network-row--head">
                <span>PROTO</span>
                <span>STATE</span>
                <span>LOCAL</span>
                <span>REMOTE</span>
                <span>PROCESS</span>
                <span>PID</span>
              </div>
              {connections.map((connection) => (
                <div
                  className="network-row"
                  key={`${connection.protocol}-${connection.local}-${connection.remote}-${connection.pid}`}
                >
                  <span className="mono">{connection.protocol}</span>
                  <span className={`network-state state-${connection.state.toLowerCase()}`}>
                    {connection.state}
                  </span>
                  <span className="mono network-address">{connection.local}</span>
                  <span className="mono network-address">{connection.remote}</span>
                  <span className="mono network-process">{connection.process || '—'}</span>
                  <span className="mono">{connection.pid ?? '—'}</span>
                </div>
              ))}
              {connections.length === 0 && (
                <div className="process-table__empty">no established connections matched</div>
              )}
            </div>
          </section>

          {report.stats.length > 0 && (
            <details className="network-stats">
              <summary>socket summary, DNS and default route</summary>
              <pre>{report.stats.join('\n')}</pre>
            </details>
          )}
        </>
      )}
    </div>
  )
}
