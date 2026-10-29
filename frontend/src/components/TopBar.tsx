import { useAppStore } from '@/store/useAppStore'
import {
  connectProfile,
  detectServerFor,
  openAudit,
  openMonitor,
  openServices,
} from '@/lib/actions'
import {
  ActivityIcon,
  EditIcon,
  FileIcon,
  RefreshIcon,
  ServerIcon,
  ShieldIcon,
} from '@/components/Icons'
import { shortFingerprint } from '@/lib/format'
import type { Profile } from '@/types'

interface TopBarProps {
  profile: Profile | null
  onEdit: (profile: Profile) => void
}

export function TopBar({ profile, onEdit }: TopBarProps) {
  const servers = useAppStore((state) => state.servers)
  const poolStats = useAppStore((state) => state.poolStats)
  const server = profile ? servers[profile.id] : undefined
  const stats = profile && poolStats?.profileId === profile.id ? poolStats : null

  return (
    <header className="top-bar">
      <div className="top-bar__identity">
        {profile ? (
          <>
            <span className="profile-dot" style={{ background: profile.color }} />
            <div className="top-bar__text">
              <div className="top-bar__title">
                {profile.name}
                <span className={`env-chip env-${profile.environment}`}>
                  {profile.environment}
                </span>
              </div>
              <div className="top-bar__subtitle">
                <span>
                  {profile.username}@{profile.host}:{profile.port}
                </span>
                {server && (
                  <>
                    <span className="subtitle-sep">/</span>
                    <span title={server.osName}>{server.osName}</span>
                    <span className="subtitle-sep">/</span>
                    <span>{server.kernel}</span>
                  </>
                )}
              </div>
            </div>
          </>
        ) : (
          <div className="top-bar__text">
            <div className="top-bar__title">No host selected</div>
            <div className="top-bar__subtitle">Create a connection to begin</div>
          </div>
        )}
      </div>

      {profile && (
        <div className="top-bar__chips">
          {server && (
            <span className="info-chip" title={server.fingerprint}>
              <ShieldIcon size={13} />
              {shortFingerprint(server.fingerprint)}
            </span>
          )}
          {server && (
            <span className="info-chip">
              {server.distroFamily} · {server.arch || 'unknown arch'}
            </span>
          )}
          {server && (
            <span className="info-chip">
              {server.cpuCount} vCPU · {Math.round(server.memTotalKb / 1024)} MiB
            </span>
          )}
          {stats && (
            <span className={`info-chip ${stats.total > 0 ? 'is-live' : ''}`}>
              pool {stats.inUse}/{stats.maxConnections}
            </span>
          )}
        </div>
      )}

      <div className="top-bar__actions">
        <button className="top-action" onClick={() => openAudit()} title="Execution log">
          <FileIcon size={14} /> Audit
        </button>
        {profile && (
          <>
            <button
              className="top-action"
              onClick={() => void detectServerFor(profile.id, true)}
              title="Detect operating system, services and resources"
            >
              <RefreshIcon size={14} /> Detect
            </button>
            <button
              className="top-action"
              onClick={() => void connectProfile(profile.id)}
              title="Open a pooled SSH transport"
            >
              <ShieldIcon size={14} /> Connect
            </button>
            <button className="top-action" onClick={() => openMonitor(profile)}>
              <ActivityIcon size={14} /> Monitor
            </button>
            <button className="top-action" onClick={() => openServices(profile)}>
              <ServerIcon size={14} /> Services
            </button>
            <button
              className="icon-button icon-button--bordered"
              onClick={() => onEdit(profile)}
              title="Edit connection"
            >
              <EditIcon size={15} />
            </button>
          </>
        )}
      </div>
    </header>
  )
}
