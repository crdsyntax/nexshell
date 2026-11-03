import { useCallback, useState } from 'react'
import { openTerminal, refreshProfiles } from '@/lib/actions'
import { parseShareError, sharingService } from '@/services/sharing.service'
import { useAppStore } from '@/store/useAppStore'
import type {
  ConflictPolicy,
  ImportReport,
  Profile,
  ShareHeaderView,
  SharePreview,
} from '@/types'

export type ImportStage = 'select' | 'preview' | 'report'

export function useImportShare(
  onClose: () => void,
  onEditProfile?: (profile: Profile) => void,
) {
  const [stage, setStage] = useState<ImportStage>('select')
  const [filePath, setFilePath] = useState('')
  const [header, setHeader] = useState<ShareHeaderView | null>(null)
  const [passphrase, setPassphrase] = useState('')

  const [preview, setPreview] = useState<SharePreview | null>(null)
  const [selectedIds, setSelectedIds] = useState<string[]>([])
  const [policy, setPolicy] = useState<ConflictPolicy>('skip')
  const [trustHostKey, setTrustHostKey] = useState(false)
  const [confirmTrustHostKey, setConfirmTrustHostKey] = useState(false)
  const [openDatabase, setOpenDatabase] = useState(false)

  const [report, setReport] = useState<ImportReport | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const inspectFile = useCallback(async (pathToInspect?: string) => {
    let targetPath = pathToInspect
    if (!targetPath) {
      const picked = await sharingService.pickOpenPath()
      if (!picked) return
      targetPath = picked
    }
    setFilePath(targetPath)
    setBusy(true)
    setError(null)
    setHeader(null)
    setPreview(null)
    try {
      const info = await sharingService.inspect(targetPath)
      setHeader(info)
      if (info.expired) {
        setError('El archivo .2share ha caducado. Solicita uno nuevo al emisor.')
      }
    } catch (err) {
      setError(parseShareError(err).userMessage)
    } finally {
      setBusy(false)
    }
  }, [])

  const unlockFile = useCallback(async () => {
    if (!filePath || !passphrase.trim()) return
    setBusy(true)
    setError(null)
    try {
      const unlocked = await sharingService.unlock(filePath, passphrase)
      setPassphrase('')
      setPreview(unlocked)
      setSelectedIds(unlocked.connections.map((item) => item.shareEntryId))
      setPolicy('skip')
      setTrustHostKey(false)
      setConfirmTrustHostKey(false)
      const firstWithDbPass = unlocked.connections.some(
        (item) => item.database && item.hasDatabasePassword,
      )
      setOpenDatabase(firstWithDbPass)
      setStage('preview')
    } catch (err) {
      setError(parseShareError(err).userMessage)
    } finally {
      setBusy(false)
    }
  }, [filePath, passphrase])

  const toggleSelection = useCallback((shareEntryId: string) => {
    setSelectedIds((prev) =>
      prev.includes(shareEntryId)
        ? prev.filter((id) => id !== shareEntryId)
        : [...prev, shareEntryId],
    )
  }, [])

  const runImport = useCallback(async () => {
    if (selectedIds.length === 0) return
    if (trustHostKey && !confirmTrustHostKey) {
      setError('Confirma explícitamente que deseas fijar la huella del servidor en known_hosts.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const res = await sharingService.importBundle(selectedIds, policy, {
        trustHostKey: trustHostKey && confirmTrustHostKey,
        openDatabase,
      })
      await refreshProfiles()
      if (res.ephemeralDatabase) {
        useAppStore.getState().setPendingDbAuth(res.ephemeralDatabase)
      }
      setReport(res)
      setStage('report')
    } catch (err) {
      setError(parseShareError(err).userMessage)
    } finally {
      setBusy(false)
    }
  }, [confirmTrustHostKey, openDatabase, policy, selectedIds, trustHostKey])

  const completeCredentials = useCallback(
    (profileId: string) => {
      const found = useAppStore
        .getState()
        .profiles.find((item) => item.id === profileId)
      if (found && onEditProfile) {
        onEditProfile(found)
      }
    },
    [onEditProfile],
  )

  const openImportedTerminal = useCallback(
    async (profileId: string) => {
      const found = useAppStore
        .getState()
        .profiles.find((item) => item.id === profileId)
      if (found) {
        openTerminal(found)
      }
      try {
        await sharingService.discard()
      } catch (err) {
        void err
      }
      onClose()
    },
    [onClose],
  )

  const openImportedDatabase = useCallback(
    async (profileId: string) => {
      useAppStore.getState().openDatabaseTab(profileId)
      try {
        await sharingService.discard()
      } catch (err) {
        void err
      }
      onClose()
    },
    [onClose],
  )

  const discardAndClose = useCallback(async () => {
    setPassphrase('')
    setPreview(null)
    try {
      await sharingService.discard()
    } catch (err) {
      void err
    }
    onClose()
  }, [onClose])

  return {
    stage,
    filePath,
    setFilePath,
    header,
    passphrase,
    setPassphrase,
    preview,
    selectedIds,
    toggleSelection,
    policy,
    setPolicy,
    trustHostKey,
    setTrustHostKey,
    confirmTrustHostKey,
    setConfirmTrustHostKey,
    openDatabase,
    setOpenDatabase,
    report,
    busy,
    error,
    inspectFile,
    unlockFile,
    runImport,
    completeCredentials,
    openImportedTerminal,
    openImportedDatabase,
    discardAndClose,
  }
}
