import { useNetworkPanel } from './useNetworkPanel'
import {
  ActivityIcon,
  AlertIcon,
  CopyIcon,
  InfoIcon,
  NetworkIcon,
  RefreshIcon,
  SearchIcon,
  ShieldIcon,
  TerminalIcon,
  XIcon,
} from '@/components/Icons'
import { formatBps, formatBytes } from '@/lib/format'
import { endpointIp } from '@/lib/network'
import { openDirectoryTerminal, openProcessTerminal } from '@/lib/actions'

interface NetworkPanelProps {
  profileId: string
}

export function NetworkPanel({ profileId }: NetworkPanelProps) {
  const {
    profile,
    report,
    loading,
    error,
    search,
    setSearch,
    traffic,
    setTraffic,
    tab,
    setTab,
    openTraffic,
    auto,
    setAuto,
    rates,
    rootRef,
    listening,
    connections,
    publicPorts,
    related,
    relatedTx,
    relatedRx,
    owner,
    ownerIp,
    ownerLoading,
    ownerError,
    lookupOwner,
    copyOwner,
    process,
    processLoading,
    processError,
    loadProcess,
    copyProcess,
    inspection,
    inspectionLoading,
    inspectionError,
    inspectConnection,
    copyInspection,
    refresh,
    copyTable,
    copyConnection,
  } = useNetworkPanel(profileId)

  return (
    <div className="panel network-panel" ref={rootRef}>
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
          <label className="select-inline">
            <span>auto</span>
            <select
              value={auto}
              onChange={(event) => setAuto(Number(event.target.value))}
            >
              <option value={0}>off</option>
              <option value={2}>2s</option>
              <option value={5}>5s</option>
              <option value={10}>10s</option>
            </select>
          </label>
          {auto > 0 && <span className="live-chip">live {auto}s</span>}
          <button
            className="top-action"
            onClick={() => void copyTable()}
            disabled={!report}
            title="Copiar las tablas visibles en formato Markdown"
          >
            <CopyIcon size={13} /> Copy .md
          </button>
          <button className="top-action" onClick={() => void refresh()} disabled={loading}>
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
                <span>TX</span>
                <span>RX</span>
              </div>
              {connections.map((connection) => (
                <div
                  className="network-row network-row--clickable"
                  key={`${connection.protocol}-${connection.local}-${connection.remote}-${connection.pid}`}
                  onClick={() => openTraffic(connection)}
                  title="Ver tráfico de esta conexión"
                >
                  <span className="mono">{connection.protocol}</span>
                  <span className={`network-state state-${connection.state.toLowerCase()}`}>
                    {connection.state}
                  </span>
                  <span className="mono network-address">{connection.local}</span>
                  <span className="mono network-address">{connection.remote}</span>
                  <span
                    className="mono network-process"
                    title="Nombre corto del kernel (máx. 15 caracteres). Abre la conexión para leer el comando real."
                  >
                    {connection.process || '—'}
                  </span>
                  <span className="mono">{connection.pid ?? '—'}</span>
                  <span className="mono network-traffic">{formatBytes(connection.bytesSent)}</span>
                  <span className="mono network-traffic">{formatBytes(connection.bytesReceived)}</span>
                </div>
              ))}
              {connections.length === 0 && (
                <div className="process-table__empty">no established connections matched</div>
              )}
            </div>
          </section>

          {traffic && (
            <div
              className="modal-backdrop modal-backdrop--full"
              onMouseDown={(event) => {
                if (event.target === event.currentTarget) setTraffic(null)
              }}
            >
              <div
                className="modal modal--full network-detail"
                role="dialog"
                aria-modal="true"
              >
                <header className="modal__header">
                  <div>
                    <h2>
                      Tráfico · {endpointIp(traffic.remote)}
                      <span className="panel__sub">
                        {traffic.process || 'proceso desconocido'}
                      </span>
                    </h2>
                    <p>
                      {traffic.local} → {traffic.remote} · {traffic.state}
                    </p>
                  </div>
                  <button
                    className="icon-button"
                    onClick={() => setTraffic(null)}
                    title="Cerrar"
                  >
                    <XIcon size={16} />
                  </button>
                </header>

                <div className="network-detail__tabs" role="tablist">
                  <button
                    type="button"
                    role="tab"
                    aria-selected={tab === 'traffic'}
                    className={tab === 'traffic' ? 'is-active' : ''}
                    onClick={() => setTab('traffic')}
                  >
                    <ActivityIcon size={12} /> Tráfico
                    <span>{related.length}</span>
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={tab === 'process'}
                    className={tab === 'process' ? 'is-active' : ''}
                    onClick={() => setTab('process')}
                  >
                    <TerminalIcon size={12} /> Proceso
                    <span>{traffic.pid ?? '—'}</span>
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={tab === 'diagnostics'}
                    className={tab === 'diagnostics' ? 'is-active' : ''}
                    onClick={() => setTab('diagnostics')}
                  >
                    <SearchIcon size={12} /> Diagnóstico
                    {inspection && <span>{inspection.sections.length}</span>}
                  </button>
                  <button
                    type="button"
                    role="tab"
                    aria-selected={tab === 'owner'}
                    className={tab === 'owner' ? 'is-active' : ''}
                    onClick={() => setTab('owner')}
                  >
                    <InfoIcon size={12} /> Titular IP
                    {owner && <span>{owner.asn || owner.countryCode || '—'}</span>}
                  </button>
                </div>

                <div className="modal__body network-detail__body">
                  {tab === 'traffic' && (
                    <div className="network-detail__pane">
                      <div className="traffic-grid">
                        <div>
                          <span>Enviado (TX)</span>
                          <strong className="mono">{formatBytes(traffic.bytesSent)}</strong>
                        </div>
                        <div>
                          <span>Recibido (RX)</span>
                          <strong className="mono">
                            {formatBytes(traffic.bytesReceived)}
                          </strong>
                        </div>
                        <div>
                          <span>Total</span>
                          <strong className="mono">
                            {formatBytes(traffic.bytesSent + traffic.bytesReceived)}
                          </strong>
                        </div>
                        <div>
                          <span>TX/s</span>
                          <strong className="mono">
                            {formatBps(rates[`${traffic.local}|${traffic.remote}`]?.tx ?? 0)}
                          </strong>
                        </div>
                        <div>
                          <span>RX/s</span>
                          <strong className="mono">
                            {formatBps(rates[`${traffic.local}|${traffic.remote}`]?.rx ?? 0)}
                          </strong>
                        </div>
                        <div>
                          <span>RTT</span>
                          <strong className="mono">{traffic.rtt || '—'}</strong>
                        </div>
                        <div>
                          <span>PID</span>
                          <strong className="mono">{traffic.pid ?? '—'}</strong>
                        </div>
                        <div>
                          <span>Conexiones a esa IP</span>
                          <strong className="mono">{related.length}</strong>
                        </div>
                      </div>

                      <div className="traffic-total">
                        <span>Acumulado con {endpointIp(traffic.remote)}</span>
                        <strong className="mono">
                          TX {formatBytes(relatedTx)} · RX {formatBytes(relatedRx)}
                        </strong>
                      </div>

                      <section className="network-detail__panel">
                        <header>
                          <h3>
                            <NetworkIcon size={13} /> Conexiones a{' '}
                            {endpointIp(traffic.remote)}
                          </h3>
                          <span>{related.length} sockets</span>
                        </header>
                        <div className="traffic-list traffic-list--full">
                          <div className="traffic-row traffic-row--head">
                            <span>LOCAL</span>
                            <span>PROCESO</span>
                            <span>TX / RX</span>
                          </div>
                          {related.map((item, index) => (
                            <div className="traffic-row" key={`${item.local}-${index}`}>
                              <span className="mono">{item.local}</span>
                              <span className="mono">{item.process || '—'}</span>
                              <span className="mono">
                                {formatBytes(item.bytesSent)} /{' '}
                                {formatBytes(item.bytesReceived)}
                              </span>
                            </div>
                          ))}
                          {related.length === 0 && (
                            <div className="process-table__empty">
                              sin conexiones registradas
                            </div>
                          )}
                        </div>
                      </section>
                    </div>
                  )}

                  {tab === 'process' && (
                    <div className="network-detail__pane">
                      <section className="ip-owner process-real">
                        <header>
                          <div className="ip-owner__title">
                            <TerminalIcon size={12} />
                            <h3>Proceso real</h3>
                            <span className="mono">PID {traffic.pid ?? '—'}</span>
                          </div>
                          <div className="inspection__actions">
                            <button
                              className="top-action"
                              onClick={() => setTab('diagnostics')}
                            >
                              <SearchIcon size={12} /> Diagnóstico
                            </button>
                            <button
                              className="top-action"
                              onClick={() => {
                                if (traffic.pid) void loadProcess(traffic.pid)
                              }}
                              disabled={processLoading || !traffic.pid}
                            >
                              <RefreshIcon
                                size={12}
                                className={processLoading ? 'spin' : ''}
                              />
                              {processLoading ? 'Leyendo…' : 'Actualizar'}
                            </button>
                          </div>
                        </header>

                        {processLoading && !process && (
                          <p className="ip-owner__state">Leyendo /proc/{traffic.pid}…</p>
                        )}

                        {processError && (
                          <p className="ip-owner__state ip-owner__state--error">
                            {processError}
                          </p>
                        )}

                        {process && (
                          <>
                            <div className="ip-owner__lead">
                              <strong className="process-real__command">
                                {process.command || '—'}
                              </strong>
                              <span>
                                {process.exe || 'sin ejecutable'} · {process.user} ·{' '}
                                {process.state}
                              </span>
                            </div>
                            <div className="ip-owner__grid">
                              <div className="ip-owner__wide">
                                <span>Working directory</span>
                                <strong className="mono">{process.cwd || '—'}</strong>
                              </div>
                              <div className="ip-owner__wide">
                                <span>Ejecutable</span>
                                <strong className="mono">{process.exe || '—'}</strong>
                              </div>
                              <div>
                                <span>Inicio</span>
                                <strong className="mono">{process.started || '—'}</strong>
                              </div>
                              <div>
                                <span>Hilos / FDs</span>
                                <strong className="mono">
                                  {process.threads} / {process.openFiles}
                                </strong>
                              </div>
                              <div>
                                <span>CPU / MEM</span>
                                <strong className="mono">
                                  {process.cpu.toFixed(1)}% / {process.mem.toFixed(1)}%
                                </strong>
                              </div>
                              <div>
                                <span>RSS</span>
                                <strong className="mono">
                                  {formatBytes(process.rssKb * 1024)}
                                </strong>
                              </div>
                            </div>
                            <div className="process-real__actions">
                              {profile && (
                                <button
                                  className="ghost-button"
                                  onClick={() => {
                                    openProcessTerminal(profile, process.pid)
                                    setTraffic(null)
                                  }}
                                >
                                  <TerminalIcon size={12} /> Terminal en el proceso
                                </button>
                              )}
                              {profile && (
                                <button
                                  className="ghost-button"
                                  onClick={() => {
                                    openDirectoryTerminal(profile, process.cwd)
                                    setTraffic(null)
                                  }}
                                  disabled={!process.cwd}
                                >
                                  <TerminalIcon size={12} /> Terminal en el cwd
                                </button>
                              )}
                            </div>
                          </>
                        )}
                      </section>
                    </div>
                  )}

                  {tab === 'diagnostics' && (
                    <div className="network-detail__pane">
                      <section className="inspection">
                        <header>
                          <div className="ip-owner__title">
                            <SearchIcon size={12} />
                            <h3>Diagnóstico de la conexión</h3>
                            <span className="mono">{traffic.remote}</span>
                          </div>
                          <div className="inspection__actions">
                            <button
                              className="top-action"
                              onClick={() => void inspectConnection(false)}
                              disabled={inspectionLoading || !traffic.pid}
                            >
                              <RefreshIcon
                                size={12}
                                className={inspectionLoading ? 'spin' : ''}
                              />
                              {inspectionLoading ? 'Analizando…' : 'Reanalizar'}
                            </button>
                            <button
                              className="top-action"
                              onClick={() => void inspectConnection(true)}
                              disabled={inspectionLoading || !traffic.pid}
                            >
                              <ShieldIcon size={12} /> Sondear TLS
                            </button>
                          </div>
                        </header>

                        {!traffic.pid && (
                          <p className="ip-owner__state">
                            La conexión no expone PID.
                          </p>
                        )}

                        {inspectionLoading && !inspection && (
                          <p className="ip-owner__state">Analizando sockets y proceso…</p>
                        )}

                        {inspectionError && (
                          <p className="ip-owner__state ip-owner__state--error">
                            {inspectionError}
                          </p>
                        )}

                        {inspection?.sections.map((section) => (
                          <details className="inspection__block" key={section.title} open>
                            <summary>
                              {section.title}
                              <span>{section.lines.length}</span>
                            </summary>
                            <pre>{section.lines.join('\n')}</pre>
                          </details>
                        ))}
                      </section>
                    </div>
                  )}

                  {tab === 'owner' && (
                    <div className="network-detail__pane">
                      <section className="ip-owner">
                        <header>
                          <div className="ip-owner__title">
                            <InfoIcon size={12} />
                            <h3>¿De quién es esta IP?</h3>
                            <span className="mono">{ownerIp}</span>
                          </div>
                          <button
                            className="top-action"
                            onClick={() => void lookupOwner(ownerIp, true)}
                            disabled={ownerLoading || !ownerIp}
                          >
                            <RefreshIcon
                              size={12}
                              className={ownerLoading ? 'spin' : ''}
                            />
                            {ownerLoading ? 'Consultando…' : 'Reconsultar'}
                          </button>
                        </header>

                        {ownerLoading && !owner && (
                          <p className="ip-owner__state">Consultando ASN, WHOIS y RDAP…</p>
                        )}

                        {ownerError && (
                          <p className="ip-owner__state ip-owner__state--error">
                            {ownerError}
                          </p>
                        )}

                        {owner && (
                          <>
                            <div className="ip-owner__lead">
                              <strong>
                                {owner.organization || 'Sin organización registrada'}
                              </strong>
                              <span>
                                {[owner.isp, owner.domain].filter(Boolean).join(' · ') ||
                                  'Sin ISP declarado'}
                              </span>
                            </div>
                            <div className="ip-owner__grid">
                              <div>
                                <span>ASN</span>
                                <strong className="mono">{owner.asn || '—'}</strong>
                              </div>
                              <div>
                                <span>Tipo</span>
                                <strong className="mono">{owner.type || '—'}</strong>
                              </div>
                              <div>
                                <span>País</span>
                                <strong>
                                  {owner.country || '—'}
                                  {owner.countryCode ? ` (${owner.countryCode})` : ''}
                                </strong>
                              </div>
                              <div>
                                <span>Ciudad</span>
                                <strong>
                                  {owner.city || '—'}
                                  {owner.region ? ` · ${owner.region}` : ''}
                                </strong>
                              </div>
                              <div>
                                <span>Red registrada</span>
                                <strong className="mono">{owner.network || '—'}</strong>
                              </div>
                              <div>
                                <span>Rango</span>
                                <strong className="mono">{owner.range || '—'}</strong>
                              </div>
                              <div>
                                <span>Reverse DNS</span>
                                <strong className="mono">{owner.hostname || '—'}</strong>
                              </div>
                              <div>
                                <span>Reporte de abuso</span>
                                <strong className="mono">{owner.abuse || '—'}</strong>
                              </div>
                              <div>
                                <span>Zona horaria</span>
                                <strong className="mono">{owner.timezone || '—'}</strong>
                              </div>
                              <div>
                                <span>Fuente</span>
                                <strong>{owner.source}</strong>
                              </div>
                            </div>
                          </>
                        )}
                      </section>
                    </div>
                  )}
                </div>

                <footer className="modal__footer">
                  {tab === 'traffic' && (
                    <button
                      className="ghost-button"
                      onClick={() => void copyConnection(traffic)}
                    >
                      <CopyIcon size={13} /> Copiar conexión
                    </button>
                  )}
                  {tab === 'process' && (
                    <button
                      className="ghost-button"
                      onClick={() => void copyProcess()}
                      disabled={!process}
                    >
                      <CopyIcon size={13} /> Copiar cmdline
                    </button>
                  )}
                  {tab === 'diagnostics' && (
                    <button
                      className="ghost-button"
                      onClick={() => void copyInspection()}
                      disabled={!inspection}
                    >
                      <CopyIcon size={13} /> Copiar diagnóstico
                    </button>
                  )}
                  {tab === 'owner' && (
                    <button
                      className="ghost-button"
                      onClick={() => void copyOwner()}
                      disabled={!owner}
                    >
                      <CopyIcon size={13} /> Copiar titular
                    </button>
                  )}
                  <button className="primary-button" onClick={() => setTraffic(null)}>
                    Cerrar
                  </button>
                </footer>
              </div>
            </div>
          )}
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
