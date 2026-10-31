import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useAppStore } from '@/store/useAppStore'
import { networkService } from '@/services/network.service'
import { ipService } from '@/services/ip.service'
import { processService } from '@/services/process.service'
import {
  copyToClipboard,
  endpointIp,
  ipOwnerText,
  isPrivateIp,
  networkMarkdown,
} from '@/lib/network'
import type {
  ConnectionInspection,
  IpOwner,
  NetworkConnection,
  NetworkReport,
  ProcessDetails,
} from '@/types'

export type NetworkDetailTab = 'traffic' | 'process' | 'diagnostics' | 'owner'

export function useNetworkPanel(profileId: string) {
  const profiles = useAppStore((state) => state.profiles)
  const pushToast = useAppStore((state) => state.pushToast)
  const profile = profiles.find((item) => item.id === profileId)

  const [report, setReport] = useState<NetworkReport | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [search, setSearch] = useState('')
  const [traffic, setTraffic] = useState<NetworkConnection | null>(null)
  const [tab, setTab] = useState<NetworkDetailTab>('traffic')
  const [auto, setAuto] = useState(5)
  const [rates, setRates] = useState<Record<string, { tx: number; rx: number }>>({})
  const [owner, setOwner] = useState<IpOwner | null>(null)
  const [ownerLoading, setOwnerLoading] = useState(false)
  const [ownerError, setOwnerError] = useState<string | null>(null)
  const [process, setProcess] = useState<ProcessDetails | null>(null)
  const [processLoading, setProcessLoading] = useState(false)
  const [processError, setProcessError] = useState<string | null>(null)
  const [inspection, setInspection] = useState<ConnectionInspection | null>(null)
  const [inspectionLoading, setInspectionLoading] = useState(false)
  const [inspectionError, setInspectionError] = useState<string | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const ownerRequest = useRef(0)
  const processRequest = useRef(0)
  const inspectionRequest = useRef(0)
  const previousRef = useRef<Record<string, { tx: number; rx: number; at: number }>>({})

  const refresh = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const next = await networkService.scan(profileId)
      const now = Date.now()
      const previous = previousRef.current
      const nextRates: Record<string, { tx: number; rx: number }> = {}
      for (const connection of next.connections) {
        const key = `${connection.local}|${connection.remote}`
        const before = previous[key]
        if (before && now > before.at) {
          const seconds = (now - before.at) / 1000
          nextRates[key] = {
            tx: Math.max(0, (connection.bytesSent - before.tx) / seconds),
            rx: Math.max(0, (connection.bytesReceived - before.rx) / seconds),
          }
        }
        previous[key] = {
          tx: connection.bytesSent,
          rx: connection.bytesReceived,
          at: now,
        }
      }
      previousRef.current = previous
      setRates(nextRates)
      setReport(next)
      setTraffic((current) =>
        current
          ? next.connections.find(
              (item) => item.local === current.local && item.remote === current.remote,
            ) ?? current
          : null,
      )
    } catch (err) {
      const message = String(err)
      setError(message)
      pushToast('error', message)
    } finally {
      setLoading(false)
    }
  }, [profileId, pushToast])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useEffect(() => {
    if (auto <= 0) return
    const timer = window.setInterval(() => {
      if (rootRef.current?.offsetParent !== null) void refresh()
    }, auto * 1000)
    return () => window.clearInterval(timer)
  }, [auto, refresh])

  const ownerIp = traffic ? endpointIp(traffic.remote) : ''

  const lookupOwner = useCallback(async (ip: string, force = false) => {
    const request = ++ownerRequest.current
    if (!ip) return
    if (isPrivateIp(ip)) {
      setOwner(null)
      setOwnerLoading(false)
      setOwnerError('Dirección privada o loopback: sin registro público de titularidad.')
      return
    }
    setOwnerLoading(true)
    setOwnerError(null)
    try {
      const result = await ipService.lookup(ip, force)
      if (request === ownerRequest.current) setOwner(result)
    } catch (err) {
      if (request === ownerRequest.current) {
        setOwner(null)
        setOwnerError(String(err))
      }
    } finally {
      if (request === ownerRequest.current) setOwnerLoading(false)
    }
  }, [])

  useEffect(() => {
    if (!ownerIp) {
      ownerRequest.current += 1
      setOwner(null)
      setOwnerError(null)
      setOwnerLoading(false)
      return
    }
    setOwner(null)
    setOwnerError(null)
    void lookupOwner(ownerIp)
  }, [ownerIp, lookupOwner])

  const openTraffic = useCallback((connection: NetworkConnection) => {
    setTraffic(connection)
    setTab('traffic')
    setInspection(null)
    setInspectionError(null)
    setInspectionLoading(false)
  }, [])

  useEffect(() => {
    if (!traffic) return
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setTraffic(null)
    }
    document.addEventListener('keydown', closeOnEscape)
    return () => document.removeEventListener('keydown', closeOnEscape)
  }, [traffic])

  const trafficPid = traffic?.pid ?? null

  const loadProcess = useCallback(
    async (pid: number) => {
      const request = ++processRequest.current
      setProcessLoading(true)
      setProcessError(null)
      try {
        const result = await processService.details(profileId, pid)
        if (request === processRequest.current) setProcess(result)
      } catch (err) {
        if (request === processRequest.current) {
          setProcess(null)
          setProcessError(String(err))
        }
      } finally {
        if (request === processRequest.current) setProcessLoading(false)
      }
    },
    [profileId],
  )

  useEffect(() => {
    if (!trafficPid) {
      processRequest.current += 1
      setProcess(null)
      setProcessError(null)
      setProcessLoading(false)
      return
    }
    setProcess(null)
    setProcessError(null)
    void loadProcess(trafficPid)
  }, [trafficPid, loadProcess])

  const trafficKey = traffic ? `${traffic.pid ?? '—'}|${traffic.remote}` : ''

  useEffect(() => {
    inspectionRequest.current += 1
    setInspection(null)
    setInspectionError(null)
    setInspectionLoading(false)
  }, [trafficKey])

  const inspectConnection = useCallback(
    async (probeTls = false) => {
      if (!traffic?.pid) return
      const request = ++inspectionRequest.current
      setInspectionLoading(true)
      setInspectionError(null)
      try {
        const result = await networkService.inspect(
          profileId,
          traffic.pid,
          traffic.remote,
          probeTls,
        )
        if (request === inspectionRequest.current) setInspection(result)
      } catch (err) {
        if (request === inspectionRequest.current) {
          setInspection(null)
          setInspectionError(String(err))
        }
      } finally {
        if (request === inspectionRequest.current) setInspectionLoading(false)
      }
    },
    [profileId, traffic],
  )

  useEffect(() => {
    if (tab !== 'diagnostics') return
    if (!traffic?.pid) return
    if (inspection || inspectionLoading || inspectionError) return
    void inspectConnection(false)
  }, [tab, traffic, inspection, inspectionLoading, inspectionError, inspectConnection])

  const copyInspection = useCallback(async () => {
    if (!inspection) return
    const text = inspection.sections
      .map((section) => `## ${section.title}\n${section.lines.join('\n')}`)
      .join('\n\n')
    try {
      await copyToClipboard(text)
      pushToast('success', 'Diagnóstico copiado')
    } catch (err) {
      pushToast('error', String(err))
    }
  }, [inspection, pushToast])

  const term = search.trim().toLowerCase()

  const listening = useMemo(() => {
    if (!report) return []
    if (!term) return report.listening
    return report.listening.filter((port) =>
      [port.protocol, port.local, String(port.port), port.process, port.pid ?? '']
        .join(' ')
        .toLowerCase()
        .includes(term),
    )
  }, [report, term])

  const connections = useMemo(() => {
    if (!report) return []
    if (!term) return report.connections
    return report.connections.filter((connection) =>
      [
        connection.protocol,
        connection.state,
        connection.local,
        connection.remote,
        connection.process,
        connection.pid ?? '',
      ]
        .join(' ')
        .toLowerCase()
        .includes(term),
    )
  }, [report, term])

  const publicPorts = report?.listening.filter((port) => port.public).length ?? 0

  const related = useMemo(() => {
    if (!report || !traffic) return []
    const ip = endpointIp(traffic.remote)
    return report.connections.filter(
      (connection) =>
        endpointIp(connection.remote) === ip || endpointIp(connection.local) === ip,
    )
  }, [report, traffic])

  const relatedTx = related.reduce((total, item) => total + item.bytesSent, 0)
  const relatedRx = related.reduce((total, item) => total + item.bytesReceived, 0)

  const copyTable = useCallback(async () => {
    if (!report) return
    try {
      await copyToClipboard(networkMarkdown(report, listening, connections))
      pushToast('success', 'Tablas copiadas en Markdown')
    } catch (err) {
      pushToast('error', String(err))
    }
  }, [report, listening, connections, pushToast])

  const copyConnection = useCallback(
    async (connection: NetworkConnection) => {
      const line = `${connection.local} -> ${connection.remote}  TX ${connection.bytesSent}  RX ${connection.bytesReceived}  RTT ${connection.rtt || '—'}`
      try {
        await copyToClipboard(line)
        pushToast('success', 'Conexión copiada')
      } catch (err) {
        pushToast('error', String(err))
      }
    },
    [pushToast],
  )

  const copyProcess = useCallback(async () => {
    if (!process) return
    const summary = [
      `PID ${process.pid} · ${process.user} · ${process.state}`,
      `cmdline: ${process.command || '—'}`,
      `exe: ${process.exe || '—'}`,
      `cwd: ${process.cwd || '—'}`,
      `started: ${process.started || '—'}`,
    ].join('\n')
    try {
      await copyToClipboard(summary)
      pushToast('success', 'Proceso copiado')
    } catch (err) {
      pushToast('error', String(err))
    }
  }, [process, pushToast])

  const copyOwner = useCallback(async () => {
    if (!owner) return
    try {
      await copyToClipboard(ipOwnerText(owner))
      pushToast('success', 'Titularidad de la IP copiada')
    } catch (err) {
      pushToast('error', String(err))
    }
  }, [owner, pushToast])

  return {
    profile,
    report,
    loading,
    error,
    search,
    setSearch,
    traffic,
    setTraffic,
    tab,
    setTab,
    openTraffic,
    auto,
    setAuto,
    rates,
    rootRef,
    listening,
    connections,
    publicPorts,
    related,
    relatedTx,
    relatedRx,
    owner,
    ownerIp,
    ownerLoading,
    ownerError,
    lookupOwner,
    copyOwner,
    process,
    processLoading,
    processError,
    loadProcess,
    copyProcess,
    inspection,
    inspectionLoading,
    inspectionError,
    inspectConnection,
    copyInspection,
    refresh,
    copyTable,
    copyConnection,
  }
}
