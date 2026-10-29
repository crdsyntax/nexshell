import { useCallback, useEffect, useRef, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { Sidebar } from '@/components/Sidebar'
import { TopBar } from '@/components/TopBar'
import { TabBar } from '@/components/TabBar'
import { TerminalView } from '@/components/TerminalView'
import { MetricsPanel } from '@/components/MetricsPanel'
import { ServicesPanel } from '@/components/ServicesPanel'
import { AuditPanel } from '@/components/AuditPanel'
import { DatabasePanel } from '@/components/DatabasePanel'
import { SecurityPanel } from '@/components/SecurityPanel'
import { NetworkPanel } from '@/components/NetworkPanel'
import { ConnectionModal } from '@/components/ConnectionModal'
import { EmptyState } from '@/components/EmptyState'
import { Toasts } from '@/components/Toasts'
import { useAppStore } from '@/store/useAppStore'
import { refreshProfiles } from '@/lib/actions'
import { profileService } from '@/services/profile.service'
import { pushTerminalData } from '@/lib/terminalBus'
import type { MetricsSnapshot, Profile } from '@/types'

interface TerminalDataEvent {
  sessionId: string
  data: string
}

interface TerminalClosedEvent {
  sessionId: string
  reason: string
  exitStatus: number | null
}

interface MetricsEvent {
  profileId: string
  snapshot: MetricsSnapshot
}

interface MetricsErrorEvent {
  profileId: string
  error: string
}

export default function App() {
  const profiles = useAppStore((state) => state.profiles)
  const profilesLoaded = useAppStore((state) => state.profilesLoaded)
  const activeProfileId = useAppStore((state) => state.activeProfileId)
  const tabs = useAppStore((state) => state.tabs)
  const activeTabId = useAppStore((state) => state.activeTabId)
  const poolStats = useAppStore((state) => state.poolStats)
  const servers = useAppStore((state) => state.servers)
  const [modalOpen, setModalOpen] = useState(false)
  const [editing, setEditing] = useState<Profile | null>(null)
  const listenersReady = useRef(false)

  const activeProfile = profiles.find((profile) => profile.id === activeProfileId) ?? null
  const activeServer = activeProfile ? servers[activeProfile.id] : undefined

  useEffect(() => {
    refreshProfiles().catch((error) => {
      useAppStore.getState().pushToast('error', String(error))
    })
  }, [])

  useEffect(() => {
    if (listenersReady.current) return
    listenersReady.current = true
    const unlisteners: Array<() => void> = []

    void listen<TerminalDataEvent>('terminal:data', (event) => {
      pushTerminalData(event.payload.sessionId, event.payload.data)
    }).then((unlisten) => unlisteners.push(unlisten))

    void listen<TerminalClosedEvent>('terminal:closed', (event) => {
      const { sessionId, reason, exitStatus } = event.payload
      const store = useAppStore.getState()
      const tab = store.tabs.find((item) => item.sessionId === sessionId)
      if (!tab) return
      const detail =
        exitStatus === null || exitStatus === undefined
          ? reason
          : `${reason} (exit ${exitStatus})`
      store.setTabStatus(tab.id, 'closed', detail)
      if (reason !== 'terminal closed by user') {
        store.pushToast('error', `${tab.title}: ${detail}`)
      }
    }).then((unlisten) => unlisteners.push(unlisten))

    void listen<MetricsEvent>('metrics:update', (event) => {
      useAppStore
        .getState()
        .setMetrics(event.payload.profileId, event.payload.snapshot)
    }).then((unlisten) => unlisteners.push(unlisten))

    void listen<MetricsErrorEvent>('metrics:error', (event) => {
      useAppStore.getState().setMetricsError(event.payload.profileId, event.payload.error)
    }).then((unlisten) => unlisteners.push(unlisten))

    return () => {
      for (const unlisten of unlisteners) unlisten()
    }
  }, [])

  useEffect(() => {
    if (!activeProfileId) {
      useAppStore.getState().setPoolStats(null)
      return
    }
    let cancelled = false
    const load = () => {
      profileService
        .poolStats(activeProfileId)
        .then((stats) => {
          if (!cancelled) useAppStore.getState().setPoolStats(stats)
        })
        .catch(() => {
          if (!cancelled) useAppStore.getState().setPoolStats(null)
        })
    }
    load()
    const timer = window.setInterval(load, 4_000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [activeProfileId])

  const openNew = useCallback(() => {
    setEditing(null)
    setModalOpen(true)
  }, [])

  const openEdit = useCallback((profile: Profile) => {
    setEditing(profile)
    setModalOpen(true)
  }, [])

  const handleSaved = useCallback(async () => {
    setModalOpen(false)
    try {
      await refreshProfiles()
    } catch (error) {
      useAppStore.getState().pushToast('error', String(error))
    }
  }, [])

  const handleCloseModal = useCallback(() => setModalOpen(false), [])

  return (
    <div className="app-shell">
      <TopBar profile={activeProfile} onEdit={openEdit} />

      <div className="app-body">
        <Sidebar onNew={openNew} onEdit={openEdit} />

        <div className="app-main">
          <TabBar />

        <div className="workspace">
          {!profilesLoaded ? (
            <div className="workspace-loading">
              <span className="spinner" /> loading profiles…
            </div>
          ) : tabs.length === 0 ? (
            <EmptyState onNew={openNew} />
          ) : (
            tabs.map((tab) => (
              <section
                key={tab.id}
                className={`tab-panel ${tab.id === activeTabId ? 'is-active' : ''}`}
                aria-hidden={tab.id !== activeTabId}
              >
                {tab.kind === 'terminal' && <TerminalView tab={tab} />}
                {tab.kind === 'monitor' && <MetricsPanel profileId={tab.profileId} />}
                {tab.kind === 'services' && <ServicesPanel profileId={tab.profileId} />}
                {tab.kind === 'audit' && <AuditPanel />}
                {tab.kind === 'database' && <DatabasePanel profileId={tab.profileId} />}
                {tab.kind === 'security' && <SecurityPanel profileId={tab.profileId} />}
                {tab.kind === 'network' && <NetworkPanel profileId={tab.profileId} />}
              </section>
            ))
          )}
        </div>

        <footer className="status-bar">
          <div className="status-bar__left">
            <span
              className={`status-dot ${
                poolStats && poolStats.profileId === activeProfileId && poolStats.total > 0
                  ? 'is-online'
                  : ''
              }`}
            />
            <span className="status-target">
              {activeProfile
                ? `${activeProfile.username.toUpperCase()}@${activeProfile.host}`
                : 'NO PROFILE SELECTED'}
            </span>
            {poolStats && poolStats.profileId === activeProfileId && (
              <span className="status-bar__metric">
                POOL {poolStats.inUse}/{poolStats.maxConnections}{' '}
                {poolStats.total > 0 ? 'ACTIVE' : 'IDLE'} · {poolStats.idle} STANDBY
              </span>
            )}
          </div>
          <div className="status-bar__right">
            <span>SSH2</span>
            <span className="status-bar__sep" />
            <span className={`status-rtt ${activeServer && activeServer.latencyMs < 60 ? 'is-good' : ''}`}>
              {activeServer ? `${activeServer.latencyMs} ms` : '—'}
            </span>
            <span className="status-bar__sep" />
            <span>{tabs.length} tab{tabs.length === 1 ? '' : 's'}</span>
          </div>
          </footer>
        </div>
      </div>

      <ConnectionModal
        open={modalOpen}
        profile={editing}
        onClose={handleCloseModal}
        onSaved={handleSaved}
      />
      <Toasts />
    </div>
  )
}
