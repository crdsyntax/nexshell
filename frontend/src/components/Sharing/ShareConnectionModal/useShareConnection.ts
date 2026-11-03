import { useCallback, useState } from 'react'
import {
  defaultShareFilename,
  isCloudSyncedPath,
  parseShareError,
  sharingService,
} from '@/services/sharing.service'
import type {
  ShareExportResult,
  ShareMode,
  ShareOptions,
  SharePrepareResult,
  ShareTarget,
} from '@/types'

export type ShareStep = 1 | 2 | 3

export function useShareConnection(target: ShareTarget | null, onClose: () => void) {
  const profile = target?.profile ?? null
  const dbTarget = target?.database ?? profile?.dbTarget ?? null
  const dbPassword = target?.dbPassword

  const [step, setStep] = useState<ShareStep>(1)
  const [mode, setMode] = useState<ShareMode>('metadata')
  const [includeSshPassword, setIncludeSshPassword] = useState(true)
  const [includePrivateKey, setIncludePrivateKey] = useState(true)
  const [includePrivateKeyFile, setIncludePrivateKeyFile] = useState(false)
  const [includePassphrase, setIncludePassphrase] = useState(false)
  const [includeDatabase, setIncludeDatabase] = useState(Boolean(dbTarget))
  const [includeDatabasePassword, setIncludeDatabasePassword] = useState(false)
  const [includeHostKey, setIncludeHostKey] = useState(true)
  const [expiresInSecs, setExpiresInSecs] = useState(86_400)

  const [prepared, setPrepared] = useState<SharePrepareResult | null>(null)
  const [oneTimePassphrase, setOneTimePassphrase] = useState<string | null>(null)
  const [savedPassphraseConfirmed, setSavedPassphraseConfirmed] = useState(false)

  const [destinationPath, setDestinationPath] = useState('')
  const [cloudConfirmed, setCloudConfirmed] = useState(false)
  const [exportResult, setExportResult] = useState<ShareExportResult | null>(null)

  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const toggleSecretsMode = useCallback(
    (enabled: boolean) => {
      if (enabled) {
        setMode('secrets')
        setIncludeSshPassword(Boolean(profile?.hasPassword))
        setIncludePrivateKey(Boolean(profile?.hasPrivateKey))
        setIncludePrivateKeyFile(false)
        setIncludePassphrase(false)
        setIncludeDatabasePassword(false)
      } else {
        setMode('metadata')
        setIncludeSshPassword(false)
        setIncludePrivateKey(false)
        setIncludePrivateKeyFile(false)
        setIncludePassphrase(false)
        setIncludeDatabasePassword(false)
      }
    },
    [profile?.hasPassword, profile?.hasPrivateKey],
  )

  const buildOptions = useCallback((): ShareOptions => {
    const isSecrets = mode === 'secrets'
    const willIncludeKey =
      isSecrets &&
      profile?.authMethod === 'key' &&
      (includePrivateKey || includePrivateKeyFile)
    return {
      mode,
      includeSshPassword:
        isSecrets && profile?.authMethod === 'password' && includeSshPassword,
      includePrivateKey:
        isSecrets && profile?.authMethod === 'key' && includePrivateKey,
      includePrivateKeyFile:
        isSecrets &&
        profile?.authMethod === 'key' &&
        Boolean(profile?.keyPath) &&
        includePrivateKeyFile,
      includePassphrase: Boolean(willIncludeKey && includePassphrase),
      includeDatabase: Boolean(dbTarget && includeDatabase),
      includeDatabasePassword: Boolean(
        isSecrets && dbTarget && includeDatabase && dbPassword && includeDatabasePassword,
      ),
      includeHostKey,
      expiresInSecs,
      databaseOverride: dbTarget && includeDatabase ? dbTarget : null,
    }
  }, [
    dbPassword,
    dbTarget,
    expiresInSecs,
    includeDatabase,
    includeDatabasePassword,
    includeHostKey,
    includePassphrase,
    includePrivateKey,
    includePrivateKeyFile,
    includeSshPassword,
    mode,
    profile?.authMethod,
    profile?.keyPath,
  ])

  const prepareShare = useCallback(async () => {
    if (!profile) return
    setBusy(true)
    setError(null)
    try {
      const options = buildOptions()
      const res = await sharingService.prepare(
        profile.id,
        options,
        options.includeDatabasePassword ? dbPassword : undefined,
      )
      setPrepared({ ...res, passphrase: '' })
      setOneTimePassphrase(res.passphrase)
      setSavedPassphraseConfirmed(false)
      setDestinationPath('')
      setCloudConfirmed(false)
      setExportResult(null)
      setStep(2)
    } catch (err) {
      setError(parseShareError(err).userMessage)
    } finally {
      setBusy(false)
    }
  }, [buildOptions, dbPassword, profile])

  const backToOptions = useCallback(async () => {
    setOneTimePassphrase(null)
    setPrepared(null)
    setSavedPassphraseConfirmed(false)
    setExportResult(null)
    setError(null)
    try {
      await sharingService.cancel()
    } catch (err) {
      void err
    }
    setStep(1)
  }, [])

  const proceedToSaveStep = useCallback(() => {
    if (!savedPassphraseConfirmed) return
    setOneTimePassphrase(null)
    setStep(3)
  }, [savedPassphraseConfirmed])

  const pickDestination = useCallback(async () => {
    if (!profile) return null
    const picked = await sharingService.pickSavePath(defaultShareFilename(profile.name))
    if (picked) {
      setDestinationPath(picked)
      setCloudConfirmed(false)
    }
    return picked
  }, [profile])

  const saveShareFile = useCallback(
    async (explicitPath?: string) => {
      if (!profile) return
      let targetPath = explicitPath ?? destinationPath
      if (!targetPath) {
        const picked = await pickDestination()
        if (!picked) return
        targetPath = picked
      }
      if (isCloudSyncedPath(targetPath) && !cloudConfirmed) {
        setError(
          'La carpeta seleccionada parece sincronizada en la nube. Confirma explícitamente para guardar ahí.',
        )
        return
      }
      setBusy(true)
      setError(null)
      try {
        const res = await sharingService.exportFile(targetPath)
        setExportResult(res)
      } catch (err) {
        setError(parseShareError(err).userMessage)
      } finally {
        setBusy(false)
      }
    },
    [cloudConfirmed, destinationPath, pickDestination, profile],
  )

  const cancelAndClose = useCallback(async () => {
    setOneTimePassphrase(null)
    setPrepared(null)
    if (!exportResult) {
      try {
        await sharingService.cancel()
      } catch (err) {
        void err
      }
    }
    onClose()
  }, [exportResult, onClose])

  return {
    profile,
    dbTarget,
    hasActiveDbPassword: Boolean(dbPassword),
    step,
    mode,
    includeSshPassword,
    setIncludeSshPassword,
    includePrivateKey,
    setIncludePrivateKey,
    includePrivateKeyFile,
    setIncludePrivateKeyFile,
    includePassphrase,
    setIncludePassphrase,
    includeDatabase,
    setIncludeDatabase,
    includeDatabasePassword,
    setIncludeDatabasePassword,
    includeHostKey,
    setIncludeHostKey,
    expiresInSecs,
    setExpiresInSecs,
    toggleSecretsMode,
    prepared,
    oneTimePassphrase,
    savedPassphraseConfirmed,
    setSavedPassphraseConfirmed,
    destinationPath,
    setDestinationPath,
    isCloudPath: Boolean(destinationPath && isCloudSyncedPath(destinationPath)),
    cloudConfirmed,
    setCloudConfirmed,
    exportResult,
    busy,
    error,
    prepareShare,
    backToOptions,
    proceedToSaveStep,
    pickDestination,
    saveShareFile,
    cancelAndClose,
  }
}
