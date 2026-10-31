import { forensicsService } from '@/services/forensics.service'
import { incidentService } from '@/services/incident.service'
import { useAppStore } from '@/store/useAppStore'
import type { ArtifactEntry, AuthAttempt, SearchHit, SecretHit, SessionEntry } from '@/types'
import { useCallback, useEffect, useMemo, useState } from 'react'

type ForensicsSection = 'sessions' | 'auth' | 'artifacts' | 'search' | 'secrets'

export function useForensicsView(profileId: string) {
  const pushToast = useAppStore((state) => state.pushToast)
  const [section, setSection] = useState<ForensicsSection>('sessions')
  const [sessions, setSessions] = useState<SessionEntry[]>([])
  const [attempts, setAttempts] = useState<AuthAttempt[]>([])
  const [artifacts, setArtifacts] = useState<ArtifactEntry[]>([])
  const [hits, setHits] = useState<SearchHit[]>([])
  const [secrets, setSecrets] = useState<SecretHit[]>([])
  const [path, setPath] = useState('/root')
  const [query, setQuery] = useState('')
  const [regex, setRegex] = useState(false)
  const [filter, setFilter] = useState('')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [blockedIps, setBlockedIps] = useState<string[]>([])
  const [blocking, setBlocking] = useState<string | null>(null)
  const run = useCallback(
    async (target: ForensicsSection) => {
      setLoading(true)
      setError(null)
      try {
        if (target === 'sessions') setSessions(await forensicsService.sessions(profileId))
        if (target === 'auth') setAttempts(await forensicsService.auth(profileId, 300))
        if (target === 'artifacts') setArtifacts(await forensicsService.artifacts(profileId, path))
        if (target === 'search') {
          if (!query.trim()) {
            setError('Escribe un texto para buscar.')
            return
          }
          setHits(await forensicsService.search(profileId, path, query.trim(), regex))
        }
        if (target === 'secrets') setSecrets(await forensicsService.secrets(profileId, path))
      } catch (err) {
        const message = String(err)
        setError(message)
        pushToast('error', message)
      } finally {
        setLoading(false)
      }
    },
    [profileId, path, query, regex, pushToast],
  )
  useEffect(() => {
    void run('sessions')
  }, [profileId])
  useEffect(() => {
    if (section === 'auth' && attempts.length === 0) void run('auth')
  }, [section])
  const blockIp = async (ip: string) => {
    if (!ip || ip === '—') return
    if (!window.confirm(`¿Bloquear ${ip} en INPUT y OUTPUT?`)) return
    setBlocking(ip)
    try {
      const result = await incidentService.blockIp(profileId, ip, true)
      if (result.ok) {
        setBlockedIps((current) => [...new Set([...current, ip])])
        pushToast('success', result.output)
      } else {
        pushToast('error', result.output)
      }
    } catch (err) {
      pushToast('error', String(err))
    } finally {
      setBlocking(null)
    }
  }
  const uniqueIps = useMemo(
    () => [...new Set(sessions.map((session) => session.from).filter(Boolean))],
    [sessions],
  )
  const filteredSessions = useMemo(() => {
    const term = filter.trim().toLowerCase()
    if (!term) return sessions
    return sessions.filter((session) =>
      [session.user, session.tty, session.from, session.start]
        .join(' ')
        .toLowerCase()
        .includes(term),
    )
  }, [sessions, filter])
  const aiTools = artifacts.filter((item) => item.tag === 'ai-tool')
  const authFailed = attempts.filter((item) => item.status === 'failed').length
  const authOk = attempts.filter((item) => item.status === 'success').length
  const authIps = [...new Set(attempts.map((item) => item.from).filter(Boolean))]

  return {
    aiTools,
    artifacts,
    attempts,
    authFailed,
    authIps,
    authOk,
    blockIp,
    blockedIps,
    blocking,
    error,
    filter,
    filteredSessions,
    hits,
    loading,
    path,
    query,
    regex,
    run,
    secrets,
    section,
    sessions,
    setFilter,
    setPath,
    setQuery,
    setRegex,
    setSection,
    uniqueIps,
  }
}
