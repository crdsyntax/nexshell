import { useMemo, useState } from 'react'
import { useAppStore } from '@/store/useAppStore'
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

type EnvFilter = 'all' | 'production' | 'development'

export function Sidebar({ onNew, onEdit }: SidebarProps) {
  const profiles = useAppStore((state) => state.profiles)
  const activeProfileId = useAppStore((state) => state.activeProfileId)
  const servers = useAppStore((state) => state.servers)
  const setActiveProfile = useAppStore((state) => state.setActiveProfile)
  const [query, setQuery] = useState('')
  const [envFilter, setEnvFilter] = useState<EnvFilter>('all')

  const filtered = useMemo(() => {
    const term = query.trim().toLowerCase()
    return profiles.filter((profile) => {
      if (envFilter !== 'all' && profile.environment !== envFilter) return false
      if (!term) return true
      return [profile.name, profile.host, profile.username, profile.environment]
        .join(' ')
        .toLowerCase()
        .includes(term)
    })
  }, [profiles, query, envFilter])

  const counts = useMemo(
    () => ({
      all: profiles.length,
      production: profiles.filter((profile) => profile.environment === 'production').length,
      development: profiles.filter((profile) => profile.environment === 'development').length,
      online: Object.keys(servers).length,
    }),
    [profiles, servers],
  )

  return (
    <aside className="sidebar">
      <div className="sidebar__search">
        <SearchIcon size={13} />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="FILTER NODES..."
          spellCheck={false}
        />
      </div>

      <div className="sidebar__segments">
        <button
          className={envFilter === 'all' ? 'is-active' : ''}
          onClick={() => setEnvFilter('all')}
        >
          ALL <span>({counts.all})</span>
        </button>
        <button
          className={envFilter === 'production' ? 'is-active' : ''}
          onClick={() => setEnvFilter('production')}
        >
          PRD <span>({counts.production})</span>
        </button>
        <button
          className={envFilter === 'development' ? 'is-active' : ''}
          onClick={() => setEnvFilter('development')}
        >
          DEV <span>({counts.development})</span>
        </button>
      </div>

      <div className="sidebar__section-label">
        <span>FLEET TELEMETRY</span>
        <span className="online-count">[{counts.online} ONLINE]</span>
      </div>

      <div className="sidebar__list">
        {filtered.length === 0 && (
          <div className="sidebar__empty">
            {profiles.length === 0 ? (
              <>
                <p>NO REMOTE HOSTS</p>
                <button className="text-button" onClick={onNew}>
                  CREATE FIRST NODE
                </button>
              </>
            ) : (
              <p>NO NODE MATCHES “{query}”</p>
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
                  <span className="profile-card__name">
                    {active ? '▸ ' : ''}
                    {profile.name}
                  </span>
                  <span className={`env-chip env-${profile.environment}`}>
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
                      <span className="node-tag">{server.distroId || server.distroFamily}</span>
                      <span className="node-tag">{server.hostname}</span>
                      <span className="node-tag">{server.initSystem}</span>
                    </>
                  ) : (
                    <>
                      <span className="node-tag">
                        {profile.authMethod === 'key' ? 'key' : 'password'}
                      </span>
                      <span className="node-tag">pool {profile.pool.maxConnections}</span>
                    </>
                  )}
                </div>
              </div>

              <div className="profile-card__actions" onClick={(event) => event.stopPropagation()}>
                <button className="icon-button" title="Open terminal" onClick={() => openTerminal(profile)}>
                  <TerminalIcon size={13} />
                </button>
                <button className="icon-button" title="Performance monitor" onClick={() => openMonitor(profile)}>
                  <ActivityIcon size={13} />
                </button>
                <button className="icon-button" title="Web services" onClick={() => openServices(profile)}>
                  <ServerIcon size={13} />
                </button>
                <button className="icon-button" title="Detect server" onClick={() => void detectServerFor(profile.id, true)}>
                  <RefreshIcon size={13} />
                </button>
                <button className="icon-button" title="Edit profile" onClick={() => onEdit(profile)}>
                  <EditIcon size={13} />
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
                  <TrashIcon size={13} />
                </button>
              </div>
            </div>
          )
        })}
      </div>

      <div className="sidebar__footer">
        <button className="connect-node" onClick={onNew}>
          <PlusIcon size={14} /> CONNECT NODE
        </button>
        <div className="sidebar__vault">
          <span>TOFU KEY VAULT</span>
          <span className="vault-badge">[AES-256]</span>
        </div>
      </div>
    </aside>
  )
}
