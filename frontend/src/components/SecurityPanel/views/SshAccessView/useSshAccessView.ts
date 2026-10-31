import { sshService } from '@/services/ssh.service'
import { useAppStore } from '@/store/useAppStore'
import type { SshConfig, SshKey } from '@/types'
import { useCallback, useEffect, useState } from 'react'

export function useSshAccessView(profileId: string) {
  const profiles = useAppStore((state) => state.profiles)
  const profile = profiles.find((item) => item.id === profileId)
  const pushToast = useAppStore((state) => state.pushToast)
  const [keys, setKeys] = useState<SshKey[]>([])
  const [config, setConfig] = useState<SshConfig | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [addOpen, setAddOpen] = useState(false)
  const [keyUser, setKeyUser] = useState(profile?.username ?? 'root')
  const [publicKey, setPublicKey] = useState('')
  const [adding, setAdding] = useState(false)
  const [addResult, setAddResult] = useState<string | null>(null)
  const [confirmMode, setConfirmMode] = useState<'disable' | 'enable' | null>(null)
  const [acknowledged, setAcknowledged] = useState(false)
  const [changing, setChanging] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const [nextKeys, nextConfig] = await Promise.all([
        sshService.keys(profileId),
        sshService.config(profileId),
      ])
      setKeys(nextKeys)
      setConfig(nextConfig)
    } catch (err) {
      const message = String(err)
      setError(message)
      pushToast('error', message)
    } finally {
      setLoading(false)
    }
  }, [profileId, pushToast])

  useEffect(() => {
    void load()
  }, [load])

  const submitKey = async () => {
    setAdding(true)
    setAddResult(null)
    try {
      const result = await sshService.addKey(profileId, keyUser.trim(), publicKey.trim())
      setAddResult(result.output)
      if (result.ok) {
        pushToast('success', `Key added for ${keyUser}`)
        setPublicKey('')
        await load()
      }
    } catch (err) {
      setAddResult(String(err))
    } finally {
      setAdding(false)
    }
  }

  const removeKey = async (key: SshKey) => {
    if (!window.confirm(`Remove key ${key.fingerprint} from ${key.user}?`)) return
    try {
      const result = await sshService.removeKey(profileId, key.user, key.raw)
      pushToast(result.ok ? 'success' : 'error', result.output)
      if (result.ok) await load()
    } catch (err) {
      pushToast('error', String(err))
    }
  }

  const changeAccess = async () => {
    if (!confirmMode) return
    setChanging(true)
    try {
      const result = await sshService.setKeyOnly(
        profileId,
        confirmMode === 'disable',
        acknowledged,
      )
      pushToast(result.ok ? 'success' : 'error', result.output)
      if (result.config) setConfig(result.config)
      if (result.ok) {
        setConfirmMode(null)
        setAcknowledged(false)
      }
    } catch (err) {
      pushToast('error', String(err))
    } finally {
      setChanging(false)
    }
  }

  const passwordAuth = config?.passwordAuthentication === 'yes'

  return {
    acknowledged,
    addOpen,
    addResult,
    adding,
    changeAccess,
    changing,
    config,
    confirmMode,
    error,
    keyUser,
    keys,
    load,
    loading,
    passwordAuth,
    publicKey,
    removeKey,
    setAcknowledged,
    setAddOpen,
    setAddResult,
    setConfirmMode,
    setKeyUser,
    setPublicKey,
    submitKey,
  }
}
