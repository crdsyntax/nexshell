import { useAppStore } from '@/store/useAppStore'
import { Logo } from '@/components/Logo'
import { openMonitor, openServices, openTerminal } from '@/lib/actions'
import { ActivityIcon, KeyIcon, PlusIcon, ServerIcon, TerminalIcon } from '@/components/Icons'

interface EmptyStateProps {
  onNew: () => void
}

export function EmptyState({ onNew }: EmptyStateProps) {
  const profiles = useAppStore((state) => state.profiles)

  return (
    <div className="empty-state">
      <div className="empty-state__grid" aria-hidden />
      <div className="empty-state__content">
        <Logo size={64} className="empty-state__logo" />
        <h1>Remote operations, one console.</h1>
        {profiles.length === 0 ? (
          <div style={{ display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', justifyContent: 'center' }}>
            <button className="primary-button" onClick={onNew}>
              <PlusIcon size={16} /> Create your first connection
            </button>
            <button
              className="ghost-button"
              onClick={() => useAppStore.getState().openKeygenModal()}
              style={{ padding: '8px 16px', border: '1px solid var(--border)' }}
            >
              <KeyIcon size={15} /> Generar par de claves SSH
            </button>
          </div>
        ) : (
          <div className="empty-state__profiles">
            {profiles.slice(0, 4).map((profile) => (
              <div
                key={profile.id}
                className="empty-profile"
                style={{ ['--profile-color' as string]: profile.color }}
              >
                <div className="empty-profile__name">
                  <span className="profile-dot" style={{ background: profile.color }} />
                  {profile.name}
                </div>
                <div className="empty-profile__host">
                  {profile.username}@{profile.host}
                </div>
                <div className="empty-profile__actions">
                  <button
                    className="mini-action"
                    onClick={() => openTerminal(profile)}
                    title="Open terminal"
                  >
                    <TerminalIcon size={14} /> Terminal
                  </button>
                  <button
                    className="mini-action"
                    onClick={() => openMonitor(profile)}
                    title="Open monitor"
                  >
                    <ActivityIcon size={14} /> Monitor
                  </button>
                  <button
                    className="mini-action"
                    onClick={() => openServices(profile)}
                    title="Open services"
                  >
                    <ServerIcon size={14} /> Services
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}

        <div className="empty-state__features">
          <span>PTY-backed shells</span>
          <span>connection pooling + retry</span>
          <span>htop-style metrics</span>
          <span>validated config edits</span>
        </div>
      </div>
    </div>
  )
}
