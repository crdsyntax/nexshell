import { ipc } from '@/lib/api'
import type { NetworkReport } from '@/types'

export const networkService = {
  scan: (profileId: string) => ipc.invoke<NetworkReport>('network_scan', { profileId }),
}
