import { ipc } from '@/lib/api'
import type { IncidentActionResult, IncidentScan } from '@/types'

export const incidentService = {
  scan: (profileId: string) => ipc.invoke<IncidentScan>('incident_scan', { profileId }),
  kill: (profileId: string, pid: number) =>
    ipc.invoke<IncidentActionResult>('incident_kill_process', { profileId, pid }),
  quarantine: (profileId: string, path: string) =>
    ipc.invoke<IncidentActionResult>('incident_quarantine', { profileId, path }),
  blockIp: (profileId: string, ip: string, block: boolean) =>
    ipc.invoke<IncidentActionResult>('incident_block_ip', { profileId, ip, block }),
}
