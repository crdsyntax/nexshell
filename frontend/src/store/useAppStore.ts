import { create } from 'zustand'
import type {
  EphemeralDatabase,
  MetricsHistory,
  MetricsSnapshot,
  PoolStats,
  ProcessAuditEntry,
  Profile,
  ServerInfo,
  ServiceStatus,
  ShareTarget,
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
  terminalCwd: Record<string, string>
  alerts: Record<string, boolean>
  history: Record<string, MetricsHistory>
  processAuditLogs: Record<string, ProcessAuditEntry[]>
  metricsErrors: Record<string, string>
  services: Record<string, WebServiceInfo[]>
  serviceStatuses: Record<string, ServiceStatus[]>
  poolStats: PoolStats | null
  toasts: Toast[]
  pendingDbAuth: Record<string, EphemeralDatabase>
  shareTarget: ShareTarget | null
  importShareOpen: boolean

  setProfiles: (profiles: Profile[]) => void
  upsertProfile: (profile: Profile) => void
  removeProfile: (id: string) => void
  setActiveProfile: (id: string) => void
  openTerminalTab: (profile: Profile) => string
  openProcessTerminal: (profile: Profile, pid: number) => string
  openDirectoryTerminal: (profile: Profile, directory: string) => string
  openAuditTab: () => string
  openDatabaseTab: (profileId?: string) => string
  openSecurityTab: () => string
  openNetworkTab: (profile: Profile) => string
  openSingletonTab: (profile: Profile, kind: Exclude<TabKind, 'terminal'>) => string
  closeTab: (id: string) => void
  activateTab: (id: string) => void
  setTabSession: (tabId: string, session: TerminalInfo) => void
  setTerminalCwd: (tabId: string, cwd: string) => void
  setAlerts: (profileId: string, on: boolean) => void
  setTabStatus: (tabId: string, status: TabStatus, error?: string) => void
  setServerInfo: (profileId: string, info: ServerInfo) => void
  setMetrics: (profileId: string, snapshot: MetricsSnapshot) => void
  clearProcessAuditLog: (profileId: string) => void
  setMetricsError: (profileId: string, error: string) => void
  setServices: (profileId: string, services: WebServiceInfo[]) => void
  setServiceStatuses: (profileId: string, statuses: ServiceStatus[]) => void
  setPoolStats: (stats: PoolStats | null) => void
  clearRuntime: (profileId: string) => void
  pushToast: (kind: Toast['kind'], text: string) => void
  dismissToast: (id: string) => void
  setPendingDbAuth: (entry: EphemeralDatabase) => void
  consumePendingDbAuth: (profileId: string) => EphemeralDatabase | null
  clearPendingDbAuth: (profileId: string) => void
  openShareModal: (target: ShareTarget) => void
  closeShareModal: () => void
  openImportModal: () => void
  closeImportModal: () => void
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
  terminalCwd: {},
  alerts: {},
  history: {},
  processAuditLogs: {},
  metricsErrors: {},
  services: {},
  serviceStatuses: {},
  poolStats: null,
  toasts: [],
  pendingDbAuth: {},
  shareTarget: null,
  importShareOpen: false,

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

  openDatabaseTab: (profileId) => {
    const state = get()
    const targetProfileId = profileId ?? state.activeProfileId ?? ''
    const existing = state.tabs.find((tab) => tab.kind === 'database')
    if (existing) {
      set({
        tabs: state.tabs.map((tab) =>
          tab.id === existing.id ? { ...tab, profileId: targetProfileId } : tab,
        ),
        activeTabId: existing.id,
        activeProfileId: targetProfileId || state.activeProfileId,
      })
      return existing.id
    }
    const id = newId()
    const tab: WorkspaceTab = {
      id,
      kind: 'database',
      title: 'Databases',
      profileId: targetProfileId,
      status: 'connected',
    }
    set({
      tabs: [...state.tabs, tab],
      activeTabId: id,
      activeProfileId: targetProfileId || state.activeProfileId,
    })
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
      kind === 'monitor'
        ? 'Monitor'
        : kind === 'services'
          ? 'Services'
          : kind === 'firewall'
            ? 'Firewall'
            : 'Execution log'
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
      const closing = state.tabs.find((tab) => tab.id === id)
      const index = state.tabs.findIndex((tab) => tab.id === id)
      const tabs = state.tabs.filter((tab) => tab.id !== id)
      let activeTabId = state.activeTabId
      if (state.activeTabId === id) {
        activeTabId = tabs[Math.min(index, tabs.length - 1)]?.id ?? null
      }
      if (closing?.kind === 'database' && closing.profileId) {
        const pendingDbAuth = { ...state.pendingDbAuth }
        delete pendingDbAuth[closing.profileId]
        return { tabs, activeTabId, pendingDbAuth }
      }
      return { tabs, activeTabId }
    }),

  activateTab: (id) =>
    set((state) => {
      const tab = state.tabs.find((item) => item.id === id)
      return tab ? { activeTabId: id, activeProfileId: tab.profileId } : {}
    }),

  setAlerts: (profileId, on) =>
    set((state) => ({ alerts: { ...state.alerts, [profileId]: on } })),

  setTerminalCwd: (tabId, cwd) =>
    set((state) =>
      state.terminalCwd[tabId] === cwd
        ? {}
        : { terminalCwd: { ...state.terminalCwd, [tabId]: cwd } },
    ),

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

      // Audit process logging: record top active processes and CPU spikes
      const existingAudit = state.processAuditLogs[profileId] ?? []
      const timeStr = new Date(snapshot.timestamp * 1000).toLocaleTimeString()
      const newEntries: ProcessAuditEntry[] = []

      for (const proc of snapshot.processes) {
        const isSpike = proc.cpu >= 40.0 || (snapshot.cpuTotal >= 70.0 && proc.cpu >= 15.0)
        if (proc.cpu >= 0.5 || isSpike) {
          newEntries.push({
            ...proc,
            id: `${proc.pid}-${snapshot.timestamp}-${Math.random().toString(36).slice(2, 6)}`,
            timestamp: snapshot.timestamp,
            sampleTime: timeStr,
            isSpike,
          })
        }
      }

      if (newEntries.length === 0 && snapshot.processes.length > 0) {
        const top = snapshot.processes[0]
        newEntries.push({
          ...top,
          id: `${top.pid}-${snapshot.timestamp}-${Math.random().toString(36).slice(2, 6)}`,
          timestamp: snapshot.timestamp,
          sampleTime: timeStr,
          isSpike: false,
        })
      }

      const updatedAudit = [...newEntries, ...existingAudit].slice(0, 1000)

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
        processAuditLogs: {
          ...state.processAuditLogs,
          [profileId]: updatedAudit,
        },
        metricsErrors: { ...state.metricsErrors, [profileId]: '' },
      }
    }),

  clearProcessAuditLog: (profileId) =>
    set((state) => ({
      processAuditLogs: { ...state.processAuditLogs, [profileId]: [] },
    })),

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
      const processAuditLogs = { ...state.processAuditLogs }
      const services = { ...state.services }
      const statuses = { ...state.serviceStatuses }
      const pendingDbAuth = { ...state.pendingDbAuth }
      delete servers[profileId]
      delete metrics[profileId]
      delete history[profileId]
      delete processAuditLogs[profileId]
      delete services[profileId]
      delete statuses[profileId]
      delete pendingDbAuth[profileId]
      return {
        servers,
        metrics,
        history,
        processAuditLogs,
        services,
        serviceStatuses: statuses,
        pendingDbAuth,
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

  setPendingDbAuth: (entry) =>
    set((state) => ({
      pendingDbAuth: {
        ...state.pendingDbAuth,
        [entry.profileId]: entry,
      },
    })),

  consumePendingDbAuth: (profileId) => {
    const state = get()
    const entry = state.pendingDbAuth[profileId]
    if (!entry) return null
    const next = { ...state.pendingDbAuth }
    delete next[profileId]
    set({ pendingDbAuth: next })
    const nowSecs = Math.floor(Date.now() / 1000)
    if (nowSecs > entry.expiresAt) {
      return null
    }
    return entry
  },

  clearPendingDbAuth: (profileId) =>
    set((state) => {
      if (!(profileId in state.pendingDbAuth)) return {}
      const next = { ...state.pendingDbAuth }
      delete next[profileId]
      return { pendingDbAuth: next }
    }),

  openShareModal: (target) => set({ shareTarget: target }),
  closeShareModal: () => set({ shareTarget: null }),
  openImportModal: () => set({ importShareOpen: true }),
  closeImportModal: () => set({ importShareOpen: false }),
}))
