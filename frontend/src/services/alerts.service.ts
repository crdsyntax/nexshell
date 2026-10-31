import { ipc } from '@/lib/api'

export const alertsService = {
  start: (profileId: string, intervalSecs = 60) =>
    ipc.invoke<void>('alerts_start', { profileId, intervalSecs }),
  stop: (profileId: string) => ipc.invoke<void>('alerts_stop', { profileId }),
  status: () => ipc.invoke<string[]>('alerts_status'),
}
