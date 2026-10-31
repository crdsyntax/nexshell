import { incidentService } from '@/services/incident.service'
import { useAppStore } from '@/store/useAppStore'
import type { IncidentScan, SuspectFile, SuspectProcess } from '@/types'
import { useCallback, useEffect, useState } from 'react'

export function useIncidentView(profileId: string) {
  const pushToast = useAppStore((state) => state.pushToast)
  const [scan, setScan] = useState<IncidentScan | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [confirm, setConfirm] = useState<{
    kind: 'kill' | 'quarantine'
    pid?: number
    path?: string
    title: string
    detail: string
  } | null>(null)
  const [running, setRunning] = useState(false)
  const [actionError, setActionError] = useState<string | null>(null)
  const [blocked, setBlocked] = useState<string[]>([])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setScan(await incidentService.scan(profileId))
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
    if (!confirm) return
    setRunning(true)
    setActionError(null)
    try {
      const result =
        confirm.kind === 'kill'
          ? await incidentService.kill(profileId, confirm.pid ?? 0)
          : await incidentService.quarantine(profileId, confirm.path ?? '')
      if (!result.ok) {
        setActionError(result.output)
        return
      }
      pushToast('success', result.output)
      setConfirm(null)
      await load()
    } catch (err) {
      setActionError(String(err))
    } finally {
      setRunning(false)
    }
  }

  const block = async (ip: string) => {
    try {
      const result = await incidentService.blockIp(profileId, ip, true)
      if (result.ok) {
        setBlocked((current) => [...new Set([...current, ip])])
        pushToast('success', result.output)
      } else {
        pushToast('error', result.output)
      }
    } catch (err) {
      pushToast('error', String(err))
    }
  }

  const askKill = (process: SuspectProcess) =>
    setConfirm({
      kind: 'kill',
      pid: process.pid,
      title: `Matar PID ${process.pid}`,
      detail: `${process.user} · ${process.exe}\n${process.command}`,
    })

  const askQuarantine = (file: SuspectFile) =>
    setConfirm({
      kind: 'quarantine',
      path: file.path,
      title: 'Mover a cuarentena',
      detail: `${file.path} (${file.mode} ${file.owner} ${file.size} bytes)`,
    })

  const counts = {
    processes: scan?.processes.length ?? 0,
    files: scan?.files.length ?? 0,
    connections: scan?.connections.length ?? 0,
    env: scan?.envHits.length ?? 0,
  }

  return {
    actionError,
    apply,
    askKill,
    askQuarantine,
    block,
    blocked,
    confirm,
    counts,
    error,
    load,
    loading,
    running,
    scan,
    setConfirm,
  }
}
