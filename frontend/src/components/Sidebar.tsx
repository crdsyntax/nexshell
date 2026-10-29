import { useMemo, useState } from 'react'
import { useAppStore } from '@/store/useAppStore'
import { Logo } from '@/components/Logo'
import {
  deleteProfile,
  detectServerFor,
  openMonitor,
  openServices,
  openTerminal,
} from '@/lib/actions'
import {
  ActivityIcon,
  EditIcon,
  PlusIcon,
  RefreshIcon,
  SearchIcon,
  ServerIcon,
  TerminalIcon,
  TrashIcon,
} from '@/components/Icons'
import type { Profile } from '@/types'

interface SidebarProps {
  onNew: () => void
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

export function Sidebar({ onNew, onEdit }: SidebarProps) {
  const profiles = useAppStore((state) => state.profiles)
  const activeProfileId = useAppStore((state) => state.activeProfileId)
  const servers = useAppStore((state) => state.servers)
  const setActiveProfile = useAppStore((state) => state.setActiveProfile)
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase()
    if (!term) return profiles
    return profiles.filter((profile) =>
      [profile.name, profile.host, profile.username, profile.environment]
        .join(' ')
        .toLowerCase()
        .includes(term),
    )
  }, [profiles, query])

  return (
    <aside className="sidebar">
      <div className="sidebar__brand">
        <Logo size={34} className="brand-logo" />
        <div className="brand-copy">
          <strong>2Shell</strong>
          <span>remote operations</span>
        </div>
        <button className="icon-button" onClick={onNew} title="New connection">
          <PlusIcon size={16} />
        </button>
      </div>

      <div className="sidebar__search">
        <SearchIcon size={14} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filter hosts…"
          spellCheck={false}
        />
      </div>

      <div className="sidebar__section-label">
        <span>Connections</span>
        <span className="count-pill">{profiles.length}</span>
      </div>

      <div className="sidebar__list">
        {filtered.length === 0 && (
          <div className="sidebar__empty">
            {profiles.length === 0 ? (
              <>
                <p>No remote hosts yet.</p>
                <button className="text-button" onClick={onNew}>
                  Create your first connection
                </button>
              </>
            ) : (
              <p>No host matches “{query}”.</p>
            )}
          </div>
        )}

        {filtered.map((profile) => {
          const server = servers[profile.id]
          const active = profile.id === activeProfileId
          return (
            <div
              key={profile.id}
              className={`profile-card ${active ? 'is-active' : ''}`}
              style={{ ['--profile-color' as string]: profile.color }}
              onClick={() => setActiveProfile(profile.id)}
              onDoubleClick={() => openTerminal(profile)}
            >
              <div className="profile-card__stripe" />
              <div className="profile-card__body">
                <div className="profile-card__title-row">
                  <span className="profile-card__name">{profile.name}</span>
                  <span
                    className={`env-chip env-${profile.environment}`}
                    title={profile.environment}
                  >
                    {envLabel(profile.environment)}
                  </span>
                </div>
                <div className="profile-card__host">
                  {profile.username}@{profile.host}
                  {profile.port !== 22 ? `:${profile.port}` : ''}
                </div>
                <div className="profile-card__meta">
                  {server ? (
                    <>
                      <span className="server-chip" title={server.osName}>
                        {server.distroId || server.distroFamily}
                      </span>
                      <span>{server.hostname}</span>
                      <span className="meta-dim">{server.initSystem}</span>
                    </>
                  ) : (
                    <>
                      <span className="meta-dim">
                        {profile.authMethod === 'key' ? 'key auth' : 'password auth'}
                      </span>
                      <span className="meta-dim">
                        pool {profile.pool.maxConnections}
                      </span>
                    </>
                  )}
                </div>
              </div>

              <div className="profile-card__actions" onClick={(event) => event.stopPropagation()}>
                <button
                  className="icon-button"
                  title="Open terminal"
                  onClick={() => openTerminal(profile)}
                >
                  <TerminalIcon size={14} />
                </button>
                <button
                  className="icon-button"
                  title="Performance monitor"
                  onClick={() => openMonitor(profile)}
                >
                  <ActivityIcon size={14} />
                </button>
                <button
                  className="icon-button"
                  title="Web services"
                  onClick={() => openServices(profile)}
                >
                  <ServerIcon size={14} />
                </button>
                <button
                  className="icon-button"
                  title="Detect server"
                  onClick={() => void detectServerFor(profile.id, true)}
                >
                  <RefreshIcon size={14} />
                </button>
                <button
                  className="icon-button"
                  title="Edit profile"
                  onClick={() => onEdit(profile)}
                >
                  <EditIcon size={14} />
                </button>
                <button
                  className="icon-button is-danger"
                  title="Delete profile"
                  onClick={() => {
                    if (window.confirm(`Delete profile "${profile.name}"?`)) {
                      void deleteProfile(profile)
                    }
                  }}
                >
                  <TrashIcon size={14} />
                </button>
              </div>
            </div>
          )
        })}
      </div>

      <div className="sidebar__footer">
        <button className="primary-button primary-button--ghost" onClick={onNew}>
          <PlusIcon size={15} /> New connection
        </button>
        <p>Credentials encrypted locally · SSH TOFU host keys</p>
      </div>
    </aside>
  )
}
