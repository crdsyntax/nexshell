import { useFail2banView } from './useFail2banView'
import {
  AlertIcon,
  CheckIcon,
  PlusIcon,
  RefreshIcon,
  ShieldIcon,
  XIcon,
} from '@/components/Icons'

interface Fail2banViewProps {
  profileId: string
}

export function Fail2banView({ profileId }: Fail2banViewProps) {
  const {
    profile,
    report,
    loading,
    busy,
    error,
    output,
    ip,
    setIp,
    ignoreIp,
    setIgnoreIp,
    myIpLoading,
    installed,
    active,
    canManage,
    load,
    install,
    enable,
    disable,
    reload,
    ban,
    unban,
    saveIgnore,
    addMyIp,
  } = useFail2banView(profileId)

  return (
    <div className="security-view">
      <div className="sec-toolbar">
        <button className="top-action" onClick={() => void load()} disabled={loading || busy}>
          <RefreshIcon size={13} className={loading ? 'spin' : ''} /> Refresh
        </button>
        {!installed && (
          <button className="primary-button" onClick={install} disabled={busy || !canManage}>
            <PlusIcon size={13} /> Instalar y activar
          </button>
        )}
        {installed && !active && (
          <button className="primary-button" onClick={enable} disabled={busy || !canManage}>
            <ShieldIcon size={13} /> Activar fail2ban
          </button>
        )}
        {installed && active && (
          <>
            <button className="ghost-button" onClick={reload} disabled={busy || !canManage}>
              Recargar
            </button>
            <button className="danger-button" onClick={disable} disabled={busy || !canManage}>
              Desactivar
            </button>
          </>
        )}
        {installed && active && !report?.sshd && (
          <button className="primary-button" onClick={enable} disabled={busy || !canManage}>
            <ShieldIcon size={13} /> Activar jail sshd
          </button>
        )}
        <span className="security-meta">
          {profile?.name ?? profileId} · {report?.version || 'fail2ban'}
        </span>
      </div>

      {error && (
        <div className="inline-alert inline-alert--error">
          <AlertIcon size={15} />
          <span>{error}</span>
        </div>
      )}

      {output && (
        <details className="network-stats">
          <summary>última salida de fail2ban</summary>
          <pre>{output}</pre>
        </details>
      )}

      {report && (
        <>
          <div className="network-summary fail2ban-summary">
            <div className={installed ? 'is-ok' : 'is-warn'}>
              <span>Instalado</span>
              <strong>{installed ? 'sí' : 'no'}</strong>
            </div>
            <div className={active ? 'is-ok' : 'is-warn'}>
              <span>Estado</span>
              <strong>{active ? 'ACTIVO' : 'INACTIVO'}</strong>
            </div>
            <div className={report.sshd ? 'is-ok' : 'is-warn'}>
              <span>Jail sshd</span>
              <strong>{report.sshd ? 'activo' : 'no'}</strong>
            </div>
            <div>
              <span>Baneadas ahora</span>
              <strong className="mono">{report.sshd?.currentlyBanned ?? 0}</strong>
            </div>
            <div>
              <span>Fallos totales</span>
              <strong className="mono">{report.sshd?.totalFailed ?? 0}</strong>
            </div>
            <div>
              <span>Jails</span>
              <strong>{report.jails.length ? report.jails.join(', ') : '—'}</strong>
            </div>
          </div>

          {report.warnings.length > 0 && (
            <div className="fail2ban-warnings">
              {report.warnings.map((warning) => (
                <div key={warning} className="inline-alert inline-alert--warn">
                  <AlertIcon size={14} />
                  <span>{warning}</span>
                </div>
              ))}
            </div>
          )}

          {report.sshd && (
            <section className="network-block">
              <header>
                <h3>
                  <ShieldIcon size={13} /> Jail sshd
                </h3>
                <span>{report.sshd.name}</span>
              </header>
              <div className="fail2ban-stats">
                <div><span>Fallos actuales</span><strong className="mono">{report.sshd.currentlyFailed}</strong></div>
                <div><span>Fallos totales</span><strong className="mono">{report.sshd.totalFailed}</strong></div>
                <div><span>Baneos actuales</span><strong className="mono">{report.sshd.currentlyBanned}</strong></div>
                <div><span>Baneos totales</span><strong className="mono">{report.sshd.totalBanned}</strong></div>
                <div><span>maxretry</span><strong className="mono">{report.sshd.maxretry}</strong></div>
                <div><span>findtime</span><strong className="mono">{report.sshd.findtime || '—'}</strong></div>
                <div><span>bantime</span><strong className="mono">{report.sshd.bantime || '—'}</strong></div>
              </div>
              <div className="fail2ban-table">
                <div className="fail2ban-row fail2ban-row--head">
                  <span>IP BANEADA</span>
                  <span>ACCIÓN</span>
                </div>
                {report.sshd.banned.map((address) => (
                  <div className="fail2ban-row" key={address}>
                    <span className="mono">{address}</span>
                    <button
                      className="ghost-button fail2ban-unban"
                      onClick={() => unban(address)}
                      disabled={busy || !canManage || !active}
                    >
                      <CheckIcon size={12} /> Desbloquear
                    </button>
                  </div>
                ))}
                {report.sshd.banned.length === 0 && (
                  <div className="process-table__empty">sin IPs baneadas</div>
                )}
              </div>
            </section>
          )}

          {installed && active && (
            <section className="network-block">
              <header>
                <h3>
                  <AlertIcon size={13} /> Banear IP
                </h3>
                <span>jail sshd</span>
              </header>
              <form
                className="fail2ban-form"
                onSubmit={(event) => {
                  event.preventDefault()
                  ban()
                }}
              >
                <input
                  value={ip}
                  onChange={(event) => setIp(event.target.value)}
                  placeholder="203.0.113.10 o 2001:db8::1"
                  spellCheck={false}
                />
                <button
                  className="danger-button"
                  type="submit"
                  disabled={busy || !canManage || !ip.trim()}
                >
                  <XIcon size={13} /> Banear
                </button>
              </form>
            </section>
          )}

          {installed && (
            <section className="network-block">
              <header>
                <h3>
                  <ShieldIcon size={13} /> IPs ignoradas
                </h3>
                <span>nunca se banean</span>
              </header>
              <div className="fail2ban-ignore">
                <input
                  value={ignoreIp}
                  onChange={(event) => setIgnoreIp(event.target.value)}
                  placeholder="127.0.0.1/8 ::1 203.0.113.7"
                  spellCheck={false}
                  disabled={!canManage || busy}
                />
                <button
                  className="ghost-button"
                  type="button"
                  onClick={() => void addMyIp()}
                  disabled={busy || myIpLoading || !canManage}
                >
                  {myIpLoading ? 'Detectando…' : 'Añadir mi IP'}
                </button>
                <button
                  className="primary-button"
                  type="button"
                  onClick={saveIgnore}
                  disabled={busy || !canManage}
                >
                  <CheckIcon size={13} /> Guardar
                </button>
              </div>
              <p className="firewall-hint">
                Separa las direcciones con espacios. Incluye siempre loopback para no
                bloquear servicios locales.
              </p>
            </section>
          )}

          {report.raw.length > 0 && (
            <details className="network-stats">
              <summary>estado de fail2ban</summary>
              <pre>{report.raw.join('\n')}</pre>
            </details>
          )}
        </>
      )}
    </div>
  )
}
