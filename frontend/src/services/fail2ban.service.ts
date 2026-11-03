import { ipc } from '@/lib/api'
import type { Fail2banActionResult, Fail2banReport } from '@/types'

export type Fail2banActionName =
  | 'install'
  | 'enable'
  | 'configure'
  | 'disable'
  | 'reload'
  | 'ban'
  | 'unban'

export interface Fail2banActionInput {
  action: Fail2banActionName
  ip?: string
  ignoreIp?: string
}

export const fail2banService = {
  report: (profileId: string) =>
    ipc.invoke<Fail2banReport>('fail2ban_report', { profileId }),
  run: (profileId: string, input: Fail2banActionInput) =>
    ipc.invoke<Fail2banActionResult>('fail2ban_action', {
      profileId,
      input: {
        action: input.action,
        ip: input.ip ?? null,
        ignoreIp: input.ignoreIp ?? null,
      },
    }),
}
