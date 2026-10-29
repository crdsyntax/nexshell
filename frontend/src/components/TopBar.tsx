import { useAppStore } from '@/store/useAppStore'
import {
  connectProfile,
  detectServerFor,
  openAudit,
  openDatabase,
  openMonitor,
  openNetwork,
  openSecurity,
  openServices,
} from '@/lib/actions'
import {
  ActivityIcon,
  DatabaseIcon,
  EditIcon,
  FileIcon,
  NetworkIcon,
  RefreshIcon,
  ServerIcon,
  ShieldIcon,
} from '@/components/Icons'
import { Logo } from '@/components/Logo'
import { shortFingerprint } from '@/lib/format'
import type { Profile } from '@/types'

interface TopBarProps {
  profile: Profile | null
  onEdit: (profile: Profile) => void
}

const ENV_LABEL: Record<string, string> = {
  production: 'PRD',
  staging: 'STG',
  development: 'DEV',
}

function envLabel(environment: string): string {
  return ENV_LABEL[environment] ?? environment.slice(0, 3).toUpperCase()
}

export function TopBar({ profile, onEdit }: TopBarProps) {
  const servers = useAppStore((state) => state.servers)
  const poolStats = useAppStore((state) => state.poolStats)
  const tabs = useAppStore((state) => state.tabs)
  const activeTabId = useAppStore((state) => state.activeTabId)
  const activeKind = tabs.find((tab) => tab.id === activeTabId)?.kind
  const server = profile ? servers[profile.id] : undefined
  const stats = profile && poolStats?.profileId === profile.id ? poolStats : null

  const action = (kind: string) => (activeKind === kind ? 'is-active' : '')

  return (
    <header className="top-bar">
      <div className="top-bar__brand">
        <Logo size={24} />
        <span className="top-bar__wordmark">2Shell</span>
      </div>

      <div className="top-bar__divider" />

      {profile ? (
        <div className="top-bar__host">
          <span className="host-env">{envLabel(profile.environment)}</span>
          <strong className="host-name">{profile.name}</strong>
          <span className="host-target">
            {profile.username}@{profile.host}
            {profile.port !== 22 ? `:${profile.port}` : ''}
          </span>
          {stats && (
            <span className="host-pool">
              pool {stats.inUse}/{stats.maxConnections}
            </span>
          )}
        </div>
      ) : (
        <div className="top-bar__host top-bar__host--empty">NO HOST SELECTED</div>
      )}

      <nav className="top-bar__actions">
        <button className={`top-action ${action('audit')}`} onClick={() => openAudit()}>
          <FileIcon size={13} /> Audit
        </button>
        <button className={`top-action ${action('database')}`} onClick={() => openDatabase()}>
          <DatabaseIcon size={13} /> DB
        </button>
        <button className={`top-action ${action('security')}`} onClick={() => openSecurity()}>
          <ShieldIcon size={13} /> Security
        </button>
        {profile && (
          <>
            <button
              className="top-action"
              onClick={() => void detectServerFor(profile.id, true)}
              title={server ? `Fingerprint ${shortFingerprint(server.fingerprint)}` : 'Detect server'}
            >
              <RefreshIcon size={13} /> Detect
            </button>
            <button
              className="top-action"
              onClick={() => void connectProfile(profile.id)}
              title="Open a pooled SSH transport"
            >
              <ShieldIcon size={13} /> Connect
            </button>
            <button className={`top-action ${action('network')}`} onClick={() => openNetwork(profile)}>
              <NetworkIcon size={13} /> Network
            </button>
            <button className={`top-action ${action('monitor')}`} onClick={() => openMonitor(profile)}>
              <ActivityIcon size={13} /> Monitor
            </button>
            <button
              className={`top-action ${action('services')}`}
              onClick={() => openServices(profile)}
            >
              <ServerIcon size={13} /> Services
            </button>
            <button className="icon-button icon-button--bordered" onClick={() => onEdit(profile)} title="Edit connection">
              <EditIcon size={14} />
            </button>
          </>
        )}
      </nav>
    </header>
  )
}
