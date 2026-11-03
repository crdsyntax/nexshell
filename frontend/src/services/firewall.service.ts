import { ipc } from '@/lib/api'
import type { FirewallActionResult, FirewallReport } from '@/types'

export type FirewallActionName =
  | 'install'
  | 'enable'
  | 'disable'
  | 'add_rule'
  | 'update_rule'
  | 'delete_rule'

export interface FirewallActionInput {
  action: FirewallActionName
  port?: string
  protocol?: string
  source?: string
  ruleId?: string
  ruleAction?: 'allow' | 'deny'
  previous?: {
    action: string
    port: string
    protocol: string
    source: string
  }
}

export const firewallService = {
  report: (profileId: string) =>
    ipc.invoke<FirewallReport>('firewall_report', { profileId }),
  run: (profileId: string, input: FirewallActionInput) =>
    ipc.invoke<FirewallActionResult>('firewall_action', {
      profileId,
      input: {
        action: input.action,
        port: input.port ?? null,
        protocol: input.protocol ?? null,
        source: input.source ?? null,
        ruleId: input.ruleId ?? null,
        ruleAction: input.ruleAction ?? null,
        previousAction: input.previous?.action ?? null,
        previousPort: input.previous?.port ?? null,
        previousProtocol: input.previous?.protocol ?? null,
        previousSource: input.previous?.source ?? null,
      },
    }),
}
