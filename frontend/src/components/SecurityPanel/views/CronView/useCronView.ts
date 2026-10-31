import { cronService } from '@/services/cron.service'
import { useAppStore } from '@/store/useAppStore'
import type { CronBackupSummary, CronEntry, CronReport } from '@/types'
import { useCallback, useEffect, useMemo, useState } from 'react'

export function useCronView(profileId: string) {
  const pushToast = useAppStore((state) => state.pushToast)
  const [report, setReport] = useState<CronReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<CronEntry | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [deleteError, setDeleteError] = useState<string | null>(null)
  const [backups, setBackups] = useState<CronBackupSummary[]>([])
  const [restoring, setRestoring] = useState<number | null>(null)

  const loadBackups = useCallback(async () => {
    try {
      setBackups(await cronService.listBackups(profileId, 30))
    } catch {
      setBackups([])
    }
  }, [profileId])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setReport(await cronService.list(profileId))
      await loadBackups()
    } catch (err) {
      const message = String(err)
      setError(message)
      pushToast('error', message)
    } finally {
      setLoading(false)
    }
  }, [profileId, pushToast, loadBackups])

  useEffect(() => {
    void load()
  }, [load])

  const canDelete = (entry: CronEntry): boolean =>
    entry.source.startsWith('crontab:') ||
    entry.source === '/etc/crontab' ||
    entry.source.startsWith('/etc/cron.d/')

  const deleteEntry = async () => {
    if (!deleteTarget) return
    setDeleting(true)
    setDeleteError(null)
    try {
      const result = await cronService.deleteEntry(
        profileId,
        deleteTarget.source,
        deleteTarget.raw,
      )
      pushToast(
        'success',
        result.backup
          ? `${result.output} · backup guardado en ${result.backup}`
          : result.output,
      )
      setDeleteTarget(null)
      await load()
    } catch (err) {
      setDeleteError(String(err))
    } finally {
      setDeleting(false)
    }
  }

  const restoreBackup = async (backup: CronBackupSummary) => {
    if (
      !window.confirm(
        `Restaurar ${backup.source} desde ${backup.backupPath}? Se sobrescribe el cron actual.`,
      )
    ) {
      return
    }
    setRestoring(backup.id)
    try {
      const output = await cronService.restoreBackup(backup.id)
      pushToast('success', output)
      await load()
    } catch (err) {
      pushToast('error', String(err))
    } finally {
      setRestoring(null)
    }
  }

  const entries = useMemo(() => {
    if (!report) return []
    const term = search.trim().toLowerCase()
    if (!term) return report.entries
    return report.entries.filter((entry) =>
      [entry.source, entry.schedule, entry.user ?? '', entry.command]
        .join(' ')
        .toLowerCase()
        .includes(term),
    )
  }, [report, search])

  return {
    backups,
    canDelete,
    deleteEntry,
    deleteError,
    deleteTarget,
    deleting,
    entries,
    error,
    load,
    loading,
    report,
    restoreBackup,
    restoring,
    search,
    setDeleteError,
    setDeleteTarget,
    setSearch,
  }
}
