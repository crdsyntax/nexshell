import { ipc } from '@/lib/api'
import type {
  SecurityAuditSummary,
  SecurityFixResult,
  SecurityReport,
  SudoersReport,
} from '@/types'

export const securityService = {
  run: (profileId: string) =>
    ipc.invoke<SecurityReport>('run_security_audit', { profileId }),
  list: (profileId: string, limit = 20) =>
    ipc.invoke<SecurityAuditSummary[]>('list_security_audits', { profileId, limit }),
  get: (id: number) =>
    ipc.invoke<SecurityReport | null>('get_security_audit', { id }),
  applyFix: (profileId: string, findingId: string) =>
    ipc.invoke<SecurityFixResult>('apply_security_fix', { profileId, findingId }),
  sudoers: (profileId: string) =>
    ipc.invoke<SudoersReport>('sudoers_report', { profileId }),
  removeSudoersRule: (profileId: string, source: string, line: string) =>
    ipc.invoke<string>('sudoers_remove_rule', { profileId, source, line }),
  setUserLock: (profileId: string, user: string, locked: boolean) =>
    ipc.invoke<string>('system_user_lock', { profileId, user, locked }),
}
