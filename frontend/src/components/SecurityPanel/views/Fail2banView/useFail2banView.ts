import { useCallback, useEffect, useState } from 'react'
import { useAppStore } from '@/store/useAppStore'
import { fail2banService } from '@/services/fail2ban.service'
import type { Fail2banActionInput } from '@/services/fail2ban.service'
import { fetchPublicIp, ipFamily } from '@/lib/netinfo'
import type { Fail2banReport } from '@/types'

const DEFAULT_IGNORE = '127.0.0.1/8 ::1'

export function useFail2banView(profileId: string) {
  const profiles = useAppStore((state) => state.profiles)
  const pushToast = useAppStore((state) => state.pushToast)
  const profile = profiles.find((item) => item.id === profileId)

  const [report, setReport] = useState<Fail2banReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [output, setOutput] = useState<string | null>(null)
  const [ip, setIp] = useState('')
  const [ignoreIp, setIgnoreIp] = useState(DEFAULT_IGNORE)
  const [myIpLoading, setMyIpLoading] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const next = await fail2banService.report(profileId)
      setReport(next)
      if (next.sshd?.ignoreip.length) {
        setIgnoreIp(next.sshd.ignoreip.join(' '))
      }
    } catch (err) {
      setError(String(err))
    } finally {
      setLoading(false)
    }
  }, [profileId])

  useEffect(() => {
    void load()
  }, [load])

  const run = useCallback(
    async (input: Fail2banActionInput, confirmation?: string): Promise<boolean> => {
      if (confirmation && !window.confirm(confirmation)) return false
      setBusy(true)
      setError(null)
      setOutput(null)
      try {
        const result = await fail2banService.run(profileId, input)
        setOutput(result.output)
        pushToast('success', `Fail2ban: ${result.action} completado`)
        const next = await fail2banService.report(profileId).catch(() => null)
        if (next) setReport(next)
        return true
      } catch (err) {
        setError(String(err))
        pushToast('error', String(err))
        return false
      } finally {
        setBusy(false)
      }
    },
    [profileId, pushToast],
  )

  const installed = report?.installed ?? false
  const active = report?.active ?? false
  const canManage = report?.canManage ?? false

  const install = useCallback(() => {
    void run(
      { action: 'install', ignoreIp },
      `¿Instalar y activar fail2ban en ${profile?.name ?? profileId}? Se habilitará el jail sshd y se ignorarán ${ignoreIp}.`,
    )
  }, [ignoreIp, profile?.name, profileId, run])

  const enable = useCallback(() => {
    void run(
      { action: 'enable', ignoreIp },
      `¿Activar fail2ban y el jail sshd en ${profile?.name ?? profileId}?`,
    )
  }, [ignoreIp, profile?.name, profileId, run])

  const disable = useCallback(() => {
    void run(
      { action: 'disable' },
      '¿Desactivar fail2ban? Dejarán de aplicarse los baneos automáticos.',
    )
  }, [run])

  const reload = useCallback(() => {
    void run({ action: 'reload' })
  }, [run])

  const ban = useCallback(() => {
    const value = ip.trim()
    if (!ipFamily(value)) {
      setError('Introduce una IPv4 o IPv6 válida.')
      return
    }
    void run(
      { action: 'ban', ip: value },
      `¿Banear ${value} en el jail sshd?`,
    ).then((ok) => {
      if (ok) setIp('')
    })
  }, [ip, run])

  const unban = useCallback(
    (value: string) => {
      void run(
        { action: 'unban', ip: value },
        `¿Desbloquear ${value} del jail sshd?`,
      )
    },
    [run],
  )

  const saveIgnore = useCallback(() => {
    void run(
      { action: 'configure', ignoreIp },
      '¿Guardar la lista de IPs ignoradas y recargar fail2ban?',
    )
  }, [ignoreIp, run])

  const addMyIp = useCallback(async () => {
    setMyIpLoading(true)
    setError(null)
    try {
      const value = await fetchPublicIp('auto')
      const tokens = ignoreIp.split(/[\s,]+/).filter(Boolean)
      if (!tokens.includes(value)) {
        setIgnoreIp([...tokens, value].join(' '))
        pushToast('success', `${value} añadida; pulsa Guardar para aplicarla`)
      }
    } catch (err) {
      setError(`No se pudo detectar tu IP: ${String(err)}`)
    } finally {
      setMyIpLoading(false)
    }
  }, [ignoreIp, pushToast])

  return {
    profile,
    report,
    loading,
    busy,
    error,
    output,
    ip,
    setIp,
    ignoreIp,
    setIgnoreIp,
    myIpLoading,
    installed,
    active,
    canManage,
    load,
    install,
    enable,
    disable,
    reload,
    ban,
    unban,
    saveIgnore,
    addMyIp,
  }
}
