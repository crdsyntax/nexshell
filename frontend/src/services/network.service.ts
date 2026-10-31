import { ipc } from '@/lib/api'
import type { ConnectionInspection, NetworkReport } from '@/types'

export const networkService = {
  scan: (profileId: string) => ipc.invoke<NetworkReport>('network_scan', { profileId }),
  inspect: (profileId: string, pid: number, remote: string, probeTls = false) =>
    ipc.invoke<ConnectionInspection>('network_inspect', {
      profileId,
      pid,
      remote,
      probeTls,
    }),
}
