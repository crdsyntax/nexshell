import { useCallback, useEffect, useState } from 'react'
import { useAppStore } from '@/store/useAppStore'
import { firewallService } from '@/services/firewall.service'
import type { FirewallActionInput } from '@/services/firewall.service'
import { fetchPublicIp, ipFamily } from '@/lib/netinfo'
import type { FirewallReport, FirewallRule } from '@/types'

export type FirewallSourceMode = 'any' | 'ipv4' | 'ipv6' | 'myip'

function ruleSource(from: string): { mode: 'any' | 'ipv4' | 'ipv6'; value: string } {
  const text = from.trim()
  if (!text || text.startsWith('Anywhere')) return { mode: 'any', value: 'any' }
  return { mode: ipFamily(text) ?? 'ipv4', value: text }
}

export function canEditRule(rule: FirewallRule): boolean {
  return (
    !rule.id.startsWith('rich:') &&
    (rule.action === 'allow' || rule.action === 'deny') &&
    /^\d+$/.test(rule.port) &&
    (rule.protocol === 'tcp' || rule.protocol === 'udp' || rule.protocol === 'any')
  )
}

export function useFirewallPanel(profileId: string) {
  const profiles = useAppStore((state) => state.profiles)
  const pushToast = useAppStore((state) => state.pushToast)
  const profile = profiles.find((item) => item.id === profileId)

  const [report, setReport] = useState<FirewallReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [output, setOutput] = useState<string | null>(null)
  const [ruleAction, setRuleAction] = useState<'allow' | 'deny'>('allow')
  const [port, setPort] = useState('')
  const [protocol, setProtocol] = useState<'tcp' | 'udp' | 'any'>('tcp')
  const [source, setSource] = useState('any')
  const [sourceMode, setSourceMode] = useState<FirewallSourceMode>('any')
  const [myIpLoading, setMyIpLoading] = useState(false)
  const [editing, setEditing] = useState<FirewallRule | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setReport(await firewallService.report(profileId))
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
    async (input: FirewallActionInput, confirmation?: string): Promise<boolean> => {
      if (confirmation && !window.confirm(confirmation)) return false
      setBusy(true)
      setError(null)
      setOutput(null)
      try {
        const result = await firewallService.run(profileId, input)
        setOutput(result.output)
        pushToast('success', `Firewall: ${result.action} completado`)
        const next = await firewallService.report(profileId).catch(() => null)
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

  const activeReport = report?.active ?? false
  const installed = report?.installed ?? false
  const canManage = report?.canManage ?? false
  const sshPorts = report?.sshPorts ?? []

  const install = useCallback(() => {
    void run(
      { action: 'install' },
      `¿Instalar un firewall en ${profile?.name ?? profileId}? No se activará todavía.`,
    )
  }, [profile?.name, profileId, run])

  const enable = useCallback(() => {
    const ports = sshPorts.join(', ')
    void run(
      { action: 'enable' },
      `¿Activar el firewall? Se permitirá SSH en ${ports || '22'} ANTES de habilitarlo. Las conexiones establecidas se mantienen.`,
    )
  }, [run, sshPorts])

  const disable = useCallback(() => {
    void run(
      { action: 'disable' },
      `¿Desactivar el firewall en ${profile?.name ?? profileId}? El VPS quedará expuesto a conexiones entrantes.`,
    )
  }, [profile?.name, profileId, run])

  const loadMyIp = useCallback(async () => {
    setMyIpLoading(true)
    setError(null)
    try {
      const ip = await fetchPublicIp('auto')
      setSource(ip)
      setSourceMode(ipFamily(ip) ?? 'ipv4')
    } catch (err) {
      setError(`No se pudo detectar tu IP: ${String(err)}`)
    } finally {
      setMyIpLoading(false)
    }
  }, [])

  const changeSourceMode = useCallback(
    (mode: FirewallSourceMode) => {
      setSourceMode(mode)
      if (mode === 'any') {
        setSource('any')
      } else if (mode === 'myip') {
        void loadMyIp()
      } else if (source === 'any' || (ipFamily(source) && ipFamily(source) !== mode)) {
        setSource('')
      }
    },
    [loadMyIp, source],
  )

  const cancelEdit = useCallback(() => {
    setEditing(null)
    setPort('')
    setRuleAction('allow')
    setProtocol('tcp')
    setSource('any')
    setSourceMode('any')
  }, [])

  const startEdit = useCallback(
    (rule: FirewallRule) => {
      if (report?.backend !== 'ufw') {
        setError('La edición de reglas está disponible con UFW; con firewalld elimina y crea una nueva.')
        return
      }
      if (!canEditRule(rule)) {
        setError('Esta regla agrupa varios puertos o es un servicio: elimínala y crea una nueva.')
        return
      }
      const normalized = ruleSource(rule.from)
      setEditing(rule)
      setRuleAction(rule.action === 'deny' ? 'deny' : 'allow')
      setPort(rule.port)
      setProtocol(
        rule.protocol === 'udp' ? 'udp' : rule.protocol === 'any' ? 'any' : 'tcp',
      )
      setSource(normalized.value)
      setSourceMode(normalized.mode)
    },
    [report?.backend],
  )

  const addRule = useCallback(() => {
    const value = port.trim()
    const parsed = Number(value)
    if (!/^\d+$/.test(value) || parsed < 1 || parsed > 65535) {
      setError('Puerto inválido: usa un número entre 1 y 65535.')
      return
    }
    const effectiveSource = sourceMode === 'any' ? 'any' : source.trim()
    if (sourceMode !== 'any' && !effectiveSource) {
      setError('Introduce una dirección IP o usa «Mi IP».')
      return
    }
    if (sourceMode === 'ipv4' && ipFamily(effectiveSource) !== 'ipv4') {
      setError('La dirección no es una IPv4 válida.')
      return
    }
    if (sourceMode === 'ipv6' && ipFamily(effectiveSource) !== 'ipv6') {
      setError('La dirección no es una IPv6 válida.')
      return
    }
    if (
      sourceMode === 'myip' &&
      (effectiveSource === 'any' || ipFamily(effectiveSource) === null)
    ) {
      setError('No se pudo detectar tu IP. Introdúcela manualmente o usa IPv4/IPv6.')
      return
    }
    if (ruleAction === 'deny' && sshPorts.includes(parsed)) {
      setError(`No se puede denegar el puerto SSH ${parsed}: bloquearías el acceso al VPS.`)
      return
    }

    const label = `${ruleAction} ${value}/${protocol} desde ${effectiveSource}`
    const sshWarning =
      sshPorts.includes(parsed) && effectiveSource !== 'any'
        ? ' Esta regla controla SSH: si la IP no es la tuya podrías perder el acceso.'
        : ''
    const input: FirewallActionInput = {
      action: editing ? 'update_rule' : 'add_rule',
      ruleId: editing?.id,
      port: value,
      protocol,
      source: effectiveSource,
      ruleAction,
      previous: editing
        ? {
            action: editing.action,
            port: editing.port,
            protocol: editing.protocol,
            source: ruleSource(editing.from).value,
          }
        : undefined,
    }
    const confirmation = editing
      ? `¿Reemplazar la regla #${editing.id} por ${label}? Se añade la nueva y se elimina la anterior.${sshWarning}`
      : ruleAction === 'deny'
        ? `¿Denegar ${protocol} ${value} desde ${effectiveSource}?`
        : undefined

    void run(input, confirmation).then((ok) => {
      if (!ok) return
      setPort('')
      setEditing(null)
      setSource('any')
      setSourceMode('any')
      setRuleAction('allow')
    })
  }, [editing, port, protocol, ruleAction, run, source, sourceMode, sshPorts])

  const removeRule = useCallback(
    (rule: FirewallRule) => {
      if (rule.id.startsWith('rich:')) {
        setError('Las reglas rich de firewalld se administran desde firewalld.')
        return
      }
      if (editing?.id === rule.id) cancelEdit()
      const coversSsh =
        rule.action === 'allow' &&
        sshPorts.some((item) => rule.port.split(',').includes(String(item)))
      void run(
        { action: 'delete_rule', ruleId: rule.id },
        coversSsh
          ? `Esta regla permite SSH (${rule.port}). Si la eliminas podrías perder el acceso. ¿Continuar?`
          : `¿Eliminar la regla ${rule.action} ${rule.port}?`,
      )
    },
    [cancelEdit, editing?.id, run, sshPorts],
  )

  return {
    profile,
    report,
    loading,
    busy,
    error,
    output,
    activeReport,
    installed,
    canManage,
    sshPorts,
    ruleAction,
    setRuleAction,
    port,
    setPort,
    protocol,
    setProtocol,
    source,
    setSource,
    sourceMode,
    setSourceMode: changeSourceMode,
    myIpLoading,
    loadMyIp,
    editing,
    startEdit,
    cancelEdit,
    load,
    install,
    enable,
    disable,
    addRule,
    removeRule,
  }
}
