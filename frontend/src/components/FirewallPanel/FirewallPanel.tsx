import { canEditRule, useFirewallPanel } from './useFirewallPanel'
import {
  AlertIcon,
  CheckIcon,
  EditIcon,
  PlusIcon,
  RefreshIcon,
  ShieldIcon,
  TrashIcon,
  WrenchIcon,
  XIcon,
} from '@/components/Icons'

interface FirewallPanelProps {
  profileId: string
}

export function FirewallPanel({ profileId }: FirewallPanelProps) {
  const {
    profile,
    report,
    loading,
    busy,
    error,
    output,
    activeReport,
    installed,
    canManage,
    sshPorts,
    ruleAction,
    setRuleAction,
    port,
    setPort,
    protocol,
    setProtocol,
    source,
    setSource,
    sourceMode,
    setSourceMode,
    myIpLoading,
    loadMyIp,
    editing,
    startEdit,
    cancelEdit,
    load,
    install,
    enable,
    disable,
    addRule,
    removeRule,
  } = useFirewallPanel(profileId)

  const sshMissing = sshPorts.filter((item) => !report?.sshAllowed.includes(item))

  return (
    <div className="panel firewall-panel">
      <div className="panel__header">
        <div>
          <div className="panel__eyebrow">
            <ShieldIcon size={14} /> ingress control
          </div>
          <h2>
            Firewall
            <span className="panel__sub">{profile?.name ?? profileId}</span>
          </h2>
          <p className="panel__description">
            UFW o firewalld, reglas de entrada y protección del puerto SSH antes de activar.
          </p>
        </div>
        <div className="panel__actions">
          <button className="top-action" onClick={() => void load()} disabled={loading || busy}>
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

      {output && (
        <details className="firewall-output">
          <summary>Última salida del comando</summary>
          <pre>{output}</pre>
        </details>
      )}

      {report && (
        <>
          <div className="network-summary firewall-summary">
            <div className={report.installed ? 'is-ok' : 'is-warn'}>
              <span>Backend</span>
              <strong className="mono">
                {report.backend === 'none' ? 'sin firewall' : report.backend}
              </strong>
            </div>
            <div className={activeReport ? 'is-ok' : 'is-warn'}>
              <span>Estado</span>
              <strong className="mono">
                {activeReport ? 'ACTIVO' : installed ? 'INACTIVO' : 'NO INSTALADO'}
              </strong>
            </div>
            <div>
              <span>Entrada por defecto</span>
              <strong className="mono">{report.defaultIncoming || '—'}</strong>
            </div>
            <div>
              <span>Salida por defecto</span>
              <strong className="mono">{report.defaultOutgoing || '—'}</strong>
            </div>
            <div className={sshMissing.length === 0 ? 'is-ok' : 'is-warn'}>
              <span>SSH</span>
              <strong className="mono">
                {sshPorts.length === 0
                  ? '—'
                  : sshPorts.map((item) => (
                      <span
                        key={item}
                        className={
                          report.sshAllowed.includes(item)
                            ? 'firewall-ssh firewall-ssh--ok'
                            : 'firewall-ssh firewall-ssh--missing'
                        }
                      >
                        {item}
                      </span>
                    ))}
              </strong>
            </div>
            <div>
              <span>Reglas</span>
              <strong className="mono">{report.rules.length}</strong>
            </div>
          </div>

          {report.warnings.length > 0 && (
            <div className="firewall-warnings">
              {report.warnings.map((warning) => (
                <div key={warning} className="inline-alert inline-alert--warn">
                  <AlertIcon size={14} />
                  <span>{warning}</span>
                </div>
              ))}
            </div>
          )}

          <div className="firewall-actions">
            {!installed && (
              <button
                className="primary-button"
                onClick={install}
                disabled={busy || !canManage}
              >
                <PlusIcon size={13} /> Instalar firewall
              </button>
            )}
            {installed && !activeReport && (
              <button
                className="primary-button"
                onClick={enable}
                disabled={busy || !canManage}
              >
                <ShieldIcon size={13} /> Activar firewall
              </button>
            )}
            {installed && activeReport && (
              <>
                <button
                  className={sshMissing.length > 0 ? 'primary-button' : 'ghost-button'}
                  onClick={enable}
                  disabled={busy || !canManage}
                >
                  <ShieldIcon size={13} /> Asegurar SSH
                </button>
                <button
                  className="danger-button"
                  onClick={disable}
                  disabled={busy || !canManage}
                >
                  Desactivar
                </button>
              </>
            )}
            {busy && <span className="firewall-busy mono">aplicando…</span>}
          </div>

          {installed && (
            <section className="network-block">
              <header>
                <h3>
                  <ShieldIcon size={13} /> Reglas de entrada
                </h3>
                <span>{report.rules.length} reglas</span>
              </header>
              <div className="firewall-table">
                <div className="firewall-row firewall-row--head">
                  <span>ACCIÓN</span>
                  <span>PUERTO</span>
                  <span>PROTO</span>
                  <span>DESDE</span>
                  <span>NOTA</span>
                  <span>ACCIONES</span>
                </div>
                {report.rules.map((rule) => (
                  <div className="firewall-row" key={`${rule.id}-${rule.port}`}>
                    <span className={`firewall-action is-${rule.action}`}>
                      {rule.action.toUpperCase()}
                    </span>
                    <span className="mono">{rule.port || '—'}</span>
                    <span className="mono">{rule.protocol || '—'}</span>
                    <span className="mono">{rule.from || '—'}</span>
                    <span className="firewall-comment">{rule.comment || '—'}</span>
                    <div className="firewall-row__actions">
                      <button
                        className="icon-button firewall-edit"
                        onClick={() => startEdit(rule)}
                        disabled={
                          busy ||
                          !canManage ||
                          report.backend !== 'ufw' ||
                          !canEditRule(rule)
                        }
                        title={
                          report.backend !== 'ufw'
                            ? 'Editar origen está disponible con UFW'
                            : canEditRule(rule)
                              ? 'Editar regla'
                              : 'Regla con varios puertos o servicio: elimínala y crea una nueva'
                        }
                      >
                        <EditIcon size={13} />
                      </button>
                      <button
                        className="icon-button firewall-delete"
                        onClick={() => removeRule(rule)}
                        disabled={busy || !canManage || rule.id.startsWith('rich:')}
                        title={
                          rule.id.startsWith('rich:')
                            ? 'Regla rich: elimínala desde firewalld'
                            : 'Eliminar regla'
                        }
                      >
                        <TrashIcon size={13} />
                      </button>
                    </div>
                  </div>
                ))}
                {report.rules.length === 0 && (
                  <div className="process-table__empty">sin reglas visibles</div>
                )}
              </div>
            </section>
          )}

          {installed && (
            <section className="network-block">
              <header>
                <h3>
                  <WrenchIcon size={13} />{' '}
                  {editing ? `Editar regla #${editing.id}` : 'Añadir regla'}
                </h3>
                {editing ? (
                  <button className="text-button" type="button" onClick={cancelEdit}>
                    <XIcon size={12} /> Cancelar
                  </button>
                ) : (
                  <span>allow / deny por puerto</span>
                )}
              </header>
              <form
                className="firewall-form"
                onSubmit={(event) => {
                  event.preventDefault()
                  addRule()
                }}
              >
                <label className="field">
                  <span>Acción</span>
                  <select
                    value={ruleAction}
                    onChange={(event) =>
                      setRuleAction(event.target.value === 'deny' ? 'deny' : 'allow')
                    }
                    disabled={Boolean(editing)}
                  >
                    <option value="allow">allow</option>
                    <option value="deny">deny</option>
                  </select>
                </label>
                <label className="field">
                  <span>Puerto</span>
                  <input
                    value={port}
                    onChange={(event) => setPort(event.target.value)}
                    placeholder="8080"
                    inputMode="numeric"
                    spellCheck={false}
                    disabled={Boolean(editing)}
                  />
                </label>
                <label className="field">
                  <span>Protocolo</span>
                  <select
                    value={protocol}
                    onChange={(event) =>
                      setProtocol(
                        event.target.value === 'udp'
                          ? 'udp'
                          : event.target.value === 'any'
                            ? 'any'
                            : 'tcp',
                      )
                    }
                    disabled={Boolean(editing)}
                  >
                    <option value="tcp">tcp</option>
                    <option value="udp">udp</option>
                    <option value="any">any</option>
                  </select>
                </label>
                <label className="field">
                  <span>Origen</span>
                  <select
                    value={sourceMode}
                    onChange={(event) =>
                      setSourceMode(
                        event.target.value as 'any' | 'ipv4' | 'ipv6' | 'myip',
                      )
                    }
                  >
                    <option value="any">Cualquiera</option>
                    <option value="ipv4">IPv4</option>
                    <option value="ipv6">IPv6</option>
                    <option value="myip">Mi IP</option>
                  </select>
                </label>
                <label className="field firewall-form__source">
                  <span>Dirección / CIDR</span>
                  <input
                    value={sourceMode === 'any' ? 'any' : source}
                    onChange={(event) => setSource(event.target.value)}
                    placeholder={
                      sourceMode === 'ipv6' ? '2001:db8::/32' : '203.0.113.10'
                    }
                    disabled={sourceMode === 'any'}
                    spellCheck={false}
                  />
                </label>
                <button
                  className="ghost-button"
                  type="button"
                  onClick={() => void loadMyIp()}
                  disabled={myIpLoading || busy}
                >
                  {myIpLoading ? 'Detectando…' : 'Usar mi IP'}
                </button>
                <button
                  className="primary-button"
                  type="submit"
                  disabled={busy || !canManage || !activeReport || !port.trim()}
                >
                  <CheckIcon size={13} /> {editing ? 'Guardar' : 'Añadir'}
                </button>
              </form>
              <p className="firewall-hint">
                {editing
                  ? 'Acción, puerto y protocolo se mantienen; cambia solo el origen. Para el resto, elimina la regla y crea otra.'
                  : 'IPv4/IPv6 aceptan una dirección o un CIDR. «Mi IP» detecta tu IP pública actual.'}
              </p>
              {!activeReport && (
                <p className="firewall-hint">
                  Activa el firewall para añadir reglas; la activación ya protege SSH.
                </p>
              )}
            </section>
          )}

          {report.raw.length > 0 && (
            <details className="network-stats">
              <summary>estado del firewall, iptables y nftables</summary>
              <pre>{report.raw.join('\n')}</pre>
            </details>
          )}
        </>
      )}
    </div>
  )
}
