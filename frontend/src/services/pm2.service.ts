import { ipc } from '@/lib/api'
import type { Pm2ActionKind, Pm2Logs, Pm2Report } from '@/types'

export const pm2Service = {
  list: (profileId: string) => ipc.invoke<Pm2Report>('pm2_list', { profileId }),
  action: (profileId: string, id: number, action: Pm2ActionKind) =>
    ipc.invoke<string>('pm2_action', { profileId, id, action }),
  logs: (profileId: string, id: number, lines = 200) =>
    ipc.invoke<Pm2Logs>('pm2_logs', { profileId, id, lines }),
}
