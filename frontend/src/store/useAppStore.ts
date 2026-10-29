import { create } from 'zustand'
import type {
  MetricsHistory,
  MetricsSnapshot,
  PoolStats,
  Profile,
  ServerInfo,
  ServiceStatus,
  TabKind,
  TabStatus,
  TerminalInfo,
  WebServiceInfo,
  WorkspaceTab,
} from '@/types'
import { newId } from '@/lib/format'

export interface Toast {
  id: string
  kind: 'success' | 'error' | 'info'
  text: string
}

interface AppStore {
  profiles: Profile[]
  profilesLoaded: boolean
  activeProfileId: string | null
  tabs: WorkspaceTab[]
  activeTabId: string | null
  servers: Record<string, ServerInfo>
  metrics: Record<string, MetricsSnapshot>
  history: Record<string, MetricsHistory>
  metricsErrors: Record<string, string>
  services: Record<string, WebServiceInfo[]>
  serviceStatuses: Record<string, ServiceStatus[]>
  poolStats: PoolStats | null
  toasts: Toast[]

  setProfiles: (profiles: Profile[]) => void
  upsertProfile: (profile: Profile) => void
  removeProfile: (id: string) => void
  setActiveProfile: (id: string) => void
  openTerminalTab: (profile: Profile) => string
  openProcessTerminal: (profile: Profile, pid: number) => string
  openDirectoryTerminal: (profile: Profile, directory: string) => string
  openAuditTab: () => string
  openDatabaseTab: () => string
  openSecurityTab: () => string
  openNetworkTab: (profile: Profile) => string
  openSingletonTab: (profile: Profile, kind: Exclude<TabKind, 'terminal'>) => string
  closeTab: (id: string) => void
  activateTab: (id: string) => void
  setTabSession: (tabId: string, session: TerminalInfo) => void
  setTabStatus: (tabId: string, status: TabStatus, error?: string) => void
  setServerInfo: (profileId: string, info: ServerInfo) => void
  setMetrics: (profileId: string, snapshot: MetricsSnapshot) => void
  setMetricsError: (profileId: string, error: string) => void
  setServices: (profileId: string, services: WebServiceInfo[]) => void
  setServiceStatuses: (profileId: string, statuses: ServiceStatus[]) => void
  setPoolStats: (stats: PoolStats | null) => void
  clearRuntime: (profileId: string) => void
  pushToast: (kind: Toast['kind'], text: string) => void
  dismissToast: (id: string) => void
}

const EMPTY_HISTORY: MetricsHistory = { cpu: [], mem: [], rx: [], tx: [] }

function pushCapped(values: number[], value: number, cap = 60): number[] {
  const next = [...values, value]
  return next.length > cap ? next.slice(next.length - cap) : next
}

export const useAppStore = create<AppStore>((set, get) => ({
  profiles: [],
  profilesLoaded: false,
  activeProfileId: null,
  tabs: [],
  activeTabId: null,
  servers: {},
  metrics: {},
  history: {},
  metricsErrors: {},
  services: {},
  serviceStatuses: {},
  poolStats: null,
  toasts: [],

  setProfiles: (profiles) =>
    set((state) => {
      const activeStillExists = profiles.some((p) => p.id === state.activeProfileId)
      return {
        profiles,
        profilesLoaded: true,
        activeProfileId: activeStillExists
          ? state.activeProfileId
          : profiles[0]?.id ?? null,
      }
    }),

  upsertProfile: (profile) =>
    set((state) => {
      const exists = state.profiles.some((p) => p.id === profile.id)
      return {
        profiles: exists
          ? state.profiles.map((p) => (p.id === profile.id ? profile : p))
          : [...state.profiles, profile],
        activeProfileId: state.activeProfileId ?? profile.id,
      }
    }),

  removeProfile: (id) =>
    set((state) => {
      const remainingProfiles = state.profiles.filter((p) => p.id !== id)
      const remainingTabs = state.tabs.filter((t) => t.profileId !== id)
      return {
        profiles: remainingProfiles,
        tabs: remainingTabs,
        activeProfileId:
          state.activeProfileId === id
            ? remainingProfiles[0]?.id ?? null
            : state.activeProfileId,
        activeTabId: remainingTabs.some((t) => t.id === state.activeTabId)
          ? state.activeTabId
          : remainingTabs[remainingTabs.length - 1]?.id ?? null,
      }
    }),

  setActiveProfile: (id) => set({ activeProfileId: id }),

  openTerminalTab: (profile) => {
    const state = get()
    const id = newId()
    const tab: WorkspaceTab = {
      id,
      kind: 'terminal',
      title: profile.name,
      profileId: profile.id,
      status: 'connecting',
    }
    set({
      tabs: [...state.tabs, tab],
      activeTabId: id,
      activeProfileId: profile.id,
    })
    return id
  },

  openProcessTerminal: (profile, pid) => {
    const state = get()
    const id = newId()
    const tab: WorkspaceTab = {
      id,
      kind: 'terminal',
      title: `pid ${pid}`,
      profileId: profile.id,
      processPid: pid,
      status: 'connecting',
    }
    set({
      tabs: [...state.tabs, tab],
      activeTabId: id,
      activeProfileId: profile.id,
    })
    return id
  },

  openDirectoryTerminal: (profile, directory) => {
    const state = get()
    const id = newId()
    const name = directory.replace(/\/$/, '').split('/').pop() || '/'
    const tab: WorkspaceTab = {
      id,
      kind: 'terminal',
      title: `${name}/`,
      profileId: profile.id,
      directory,
      status: 'connecting',
    }
    set({
      tabs: [...state.tabs, tab],
      activeTabId: id,
      activeProfileId: profile.id,
    })
    return id
  },

  openAuditTab: () => {
    const state = get()
    const existing = state.tabs.find((tab) => tab.kind === 'audit')
    if (existing) {
      set({ activeTabId: existing.id })
      return existing.id
    }
    const id = newId()
    const tab: WorkspaceTab = {
      id,
      kind: 'audit',
      title: 'Execution log',
      profileId: state.activeProfileId ?? '',
      status: 'connected',
    }
    set({ tabs: [...state.tabs, tab], activeTabId: id })
    return id
  },

  openDatabaseTab: () => {
    const state = get()
    const existing = state.tabs.find((tab) => tab.kind === 'database')
    if (existing) {
      set({ activeTabId: existing.id })
      return existing.id
    }
    const id = newId()
    const tab: WorkspaceTab = {
      id,
      kind: 'database',
      title: 'Databases',
      profileId: state.activeProfileId ?? '',
      status: 'connected',
    }
    set({ tabs: [...state.tabs, tab], activeTabId: id })
    return id
  },

  openSecurityTab: () => {
    const state = get()
    const existing = state.tabs.find((tab) => tab.kind === 'security')
    if (existing) {
      set({ activeTabId: existing.id })
      return existing.id
    }
    const id = newId()
    const tab: WorkspaceTab = {
      id,
      kind: 'security',
      title: 'Security',
      profileId: state.activeProfileId ?? '',
      status: 'connected',
    }
    set({ tabs: [...state.tabs, tab], activeTabId: id })
    return id
  },

  openNetworkTab: (profile) => {
    const state = get()
    const existing = state.tabs.find(
      (tab) => tab.kind === 'network' && tab.profileId === profile.id,
    )
    if (existing) {
      set({ activeTabId: existing.id, activeProfileId: profile.id })
      return existing.id
    }
    const id = newId()
    const tab: WorkspaceTab = {
      id,
      kind: 'network',
      title: `${profile.name} · Network`,
      profileId: profile.id,
      status: 'connected',
    }
    set({
      tabs: [...state.tabs, tab],
      activeTabId: id,
      activeProfileId: profile.id,
    })
    return id
  },

  openSingletonTab: (profile, kind) => {
    const state = get()
    const existing = state.tabs.find(
      (tab) => tab.profileId === profile.id && tab.kind === kind,
    )
    if (existing) {
      set({ activeTabId: existing.id, activeProfileId: profile.id })
      return existing.id
    }
    const id = newId()
    const label =
      kind === 'monitor' ? 'Monitor' : kind === 'services' ? 'Services' : 'Execution log'
    const tab: WorkspaceTab = {
      id,
      kind,
      title: `${profile.name} · ${label}`,
      profileId: profile.id,
      status: 'connected',
    }
    set({
      tabs: [...state.tabs, tab],
      activeTabId: id,
      activeProfileId: profile.id,
    })
    return id
  },

  closeTab: (id) =>
    set((state) => {
      const index = state.tabs.findIndex((tab) => tab.id === id)
      const tabs = state.tabs.filter((tab) => tab.id !== id)
      let activeTabId = state.activeTabId
      if (state.activeTabId === id) {
        activeTabId = tabs[Math.min(index, tabs.length - 1)]?.id ?? null
      }
      return { tabs, activeTabId }
    }),

  activateTab: (id) =>
    set((state) => {
      const tab = state.tabs.find((item) => item.id === id)
      return tab ? { activeTabId: id, activeProfileId: tab.profileId } : {}
    }),

  setTabSession: (tabId, session) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === tabId
          ? {
              ...tab,
              sessionId: session.sessionId,
              title: session.title,
              status: 'connected',
              error: undefined,
            }
          : tab,
      ),
    })),

  setTabStatus: (tabId, status, error) =>
    set((state) => ({
      tabs: state.tabs.map((tab) =>
        tab.id === tabId ? { ...tab, status, error } : tab,
      ),
    })),

  setServerInfo: (profileId, info) =>
    set((state) => ({ servers: { ...state.servers, [profileId]: info } })),

  setMetrics: (profileId, snapshot) =>
    set((state) => {
      const previous = state.history[profileId] ?? EMPTY_HISTORY
      const mem = snapshot.memTotalKb
        ? (snapshot.memUsedKb / snapshot.memTotalKb) * 100
        : 0
      return {
        metrics: { ...state.metrics, [profileId]: snapshot },
        history: {
          ...state.history,
          [profileId]: {
            cpu: pushCapped(previous.cpu, snapshot.cpuTotal),
            mem: pushCapped(previous.mem, mem),
            rx: pushCapped(previous.rx, snapshot.netRxBps),
            tx: pushCapped(previous.tx, snapshot.netTxBps),
          },
        },
        metricsErrors: { ...state.metricsErrors, [profileId]: '' },
      }
    }),

  setMetricsError: (profileId, error) =>
    set((state) => ({
      metricsErrors: { ...state.metricsErrors, [profileId]: error },
    })),

  setServices: (profileId, services) =>
    set((state) => ({ services: { ...state.services, [profileId]: services } })),

  setServiceStatuses: (profileId, statuses) =>
    set((state) => ({
      serviceStatuses: { ...state.serviceStatuses, [profileId]: statuses },
    })),

  setPoolStats: (stats) => set({ poolStats: stats }),

  clearRuntime: (profileId) =>
    set((state) => {
      const servers = { ...state.servers }
      const metrics = { ...state.metrics }
      const history = { ...state.history }
      const services = { ...state.services }
      const statuses = { ...state.serviceStatuses }
      delete servers[profileId]
      delete metrics[profileId]
      delete history[profileId]
      delete services[profileId]
      delete statuses[profileId]
      return {
        servers,
        metrics,
        history,
        services,
        serviceStatuses: statuses,
      }
    }),

  pushToast: (kind, text) => {
    const id = newId()
    set((state) => ({
      toasts: [...state.toasts.slice(-3), { id, kind, text }],
    }))
    window.setTimeout(() => {
      get().dismissToast(id)
    }, kind === 'error' ? 7000 : 4000)
  },

  dismissToast: (id) =>
    set((state) => ({ toasts: state.toasts.filter((toast) => toast.id !== id) })),
}))
