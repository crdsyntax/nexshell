import { ipc } from '@/lib/api'
import type { MetricsSnapshot } from '@/types'

export const monitorService = {
  start: (profileId: string, intervalMs = 2000) =>
    ipc.invoke<void>('monitor_start', { profileId, intervalMs }),
  stop: (profileId: string) => ipc.invoke<void>('monitor_stop', { profileId }),
  snapshot: (profileId: string) =>
    ipc.invoke<MetricsSnapshot | null>('monitor_snapshot', { profileId }),
}
