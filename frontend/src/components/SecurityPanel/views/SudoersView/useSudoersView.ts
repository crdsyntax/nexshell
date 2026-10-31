import { securityService } from '@/services/security.service'
import { useAppStore } from '@/store/useAppStore'
import type { AccountOrigin, SudoAccount, SudoersReport } from '@/types'
import { useCallback, useEffect, useMemo, useState } from 'react'

export function useSudoersView(profileId: string) {
  const pushToast = useAppStore((state) => state.pushToast)
  const [report, setReport] = useState<SudoersReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [target, setTarget] = useState<
    | { kind: 'lock' | 'unlock'; account: SudoAccount }
    | { kind: 'rule'; source: string; raw: string; principal: string }
    | null
  >(null)
  const [busy, setBusy] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [originUser, setOriginUser] = useState<string | null>(null)
  const [origin, setOrigin] = useState<AccountOrigin | null>(null)
  const [originLoading, setOriginLoading] = useState(false)
  const [originError, setOriginError] = useState<string | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setReport(await securityService.sudoers(profileId))
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

  const apply = async () => {
    if (!target) return
    setBusy(true)
    setActionError(null)
    try {
      const output =
        target.kind === 'rule'
          ? await securityService.removeSudoersRule(profileId, target.source, target.raw)
          : await securityService.setUserLock(
              profileId,
              target.account.user,
              target.kind === 'lock',
            )
      pushToast('success', output)
      setTarget(null)
      await load()
    } catch (err) {
      setActionError(String(err))
    } finally {
      setBusy(false)
    }
  }

  const openOrigin = async (user: string) => {
    setOriginUser(user)
    setOrigin(null)
    setOriginError(null)
    setOriginLoading(true)
    try {
      setOrigin(await securityService.accountOrigin(profileId, user))
    } catch (err) {
      setOriginError(String(err))
    } finally {
      setOriginLoading(false)
    }
  }

  const nopasswd = report?.rules.filter((rule) => rule.nopasswd).length ?? 0
  const privilegedUsers = useMemo(() => {
    if (!report) return []
    const members = new Set<string>()
    report.groups.forEach((group) => group.members.forEach((member) => members.add(member)))
    report.rules.forEach((rule) => members.add(rule.principal))
    return [...members]
  }, [report])

  return {
    actionError,
    apply,
    busy,
    error,
    load,
    loading,
    nopasswd,
    openOrigin,
    origin,
    originError,
    originLoading,
    originUser,
    privilegedUsers,
    report,
    setActionError,
    setOrigin,
    setOriginUser,
    setTarget,
    target,
  }
}
