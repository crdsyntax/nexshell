import { profileService } from '@/services/profile.service'
import { terminalService } from '@/services/terminal.service'
import { useAppStore } from '@/store/useAppStore'
import type { Profile } from '@/types'

export async function refreshProfiles(): Promise<void> {
  const profiles = await profileService.list()
  useAppStore.getState().setProfiles(profiles)
}

export async function detectServerFor(
  profileId: string,
  notify = false,
): Promise<void> {
  const store = useAppStore.getState()
  try {
    const info = await profileService.detectServer(profileId)
    store.setServerInfo(profileId, info)
    if (notify) {
      store.pushToast(
        'success',
        `Detected ${info.osName} on ${info.hostname} (${info.latencyMs} ms)`,
      )
    }
  } catch (error) {
    if (notify) {
      store.pushToast('error', `Server detection failed: ${String(error)}`)
    }
  }
}

export function openTerminal(profile: Profile): void {
  useAppStore.getState().openTerminalTab(profile)
  void detectServerFor(profile.id)
}

export function openProcessTerminal(profile: Profile, pid: number): void {
  useAppStore.getState().openProcessTerminal(profile, pid)
}

export function openDirectoryTerminal(profile: Profile, directory: string): void {
  useAppStore.getState().openDirectoryTerminal(profile, directory)
}

export function openAudit(): void {
  useAppStore.getState().openAuditTab()
}

export function openDatabase(): void {
  useAppStore.getState().openDatabaseTab()
}

export function openSecurity(): void {
  useAppStore.getState().openSecurityTab()
}

export function openNetwork(profile: Profile): void {
  useAppStore.getState().openNetworkTab(profile)
  void detectServerFor(profile.id)
}

export function openMonitor(profile: Profile): void {
  useAppStore.getState().openSingletonTab(profile, 'monitor')
  void detectServerFor(profile.id)
}

export function openServices(profile: Profile): void {
  useAppStore.getState().openSingletonTab(profile, 'services')
  void detectServerFor(profile.id)
}

export async function connectProfile(profileId: string): Promise<void> {
  const store = useAppStore.getState()
  try {
    const stats = await profileService.connect(profileId)
    store.setPoolStats(stats)
    store.pushToast('success', 'SSH handshake successful')
    void detectServerFor(profileId)
  } catch (error) {
    store.pushToast('error', String(error))
  }
}

export async function disconnectProfile(profileId: string): Promise<void> {
  const store = useAppStore.getState()
  try {
    await profileService.disconnect(profileId)
    store.clearRuntime(profileId)
    store.setPoolStats(null)
    store.pushToast('info', 'Profile disconnected')
  } catch (error) {
    store.pushToast('error', String(error))
  }
}

export async function deleteProfile(profile: Profile): Promise<void> {
  const store = useAppStore.getState()
  try {
    await profileService.remove(profile.id)
    store.removeProfile(profile.id)
    store.clearRuntime(profile.id)
    store.pushToast('success', `Deleted profile "${profile.name}"`)
  } catch (error) {
    store.pushToast('error', String(error))
  }
}

export function openTerminalWithCommand(profile: Profile, command: string): void {
  const tabId = useAppStore.getState().openTerminalTab(profile)
  const deadline = Date.now() + 15_000

  const attempt = () => {
    const tab = useAppStore.getState().tabs.find((item) => item.id === tabId)
    if (!tab) return
    if (tab.sessionId) {
      const sessionId = tab.sessionId
      window.setTimeout(() => {
        void terminalService.write(sessionId, `${command}\n`)
      }, 700)
      return
    }
    if (tab.status === 'closed' || tab.status === 'error' || Date.now() > deadline) {
      useAppStore
        .getState()
        .pushToast('error', 'No se pudo abrir la terminal para ejecutar el comando.')
      return
    }
    window.setTimeout(attempt, 150)
  }

  window.setTimeout(attempt, 150)
}
