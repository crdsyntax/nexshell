import { ipc } from '@/lib/api'
import type { CronBackupSummary, CronDeleteResult, CronReport } from '@/types'

export const cronService = {
  list: (profileId: string) => ipc.invoke<CronReport>('cron_list', { profileId }),
  deleteEntry: (profileId: string, source: string, rawLine: string) =>
    ipc.invoke<CronDeleteResult>('cron_delete_entry', { profileId, source, rawLine }),
  listBackups: (profileId: string, limit = 30) =>
    ipc.invoke<CronBackupSummary[]>('cron_list_backups', { profileId, limit }),
  restoreBackup: (backupId: number) =>
    ipc.invoke<string>('cron_restore_backup', { backupId }),
}
