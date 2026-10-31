import { securityService } from '@/services/security.service'
import { useAppStore } from '@/store/useAppStore'
import type { SecurityAuditSummary, SecurityFinding, SecurityReport } from '@/types'
import { useCallback, useEffect, useMemo, useState } from 'react'

export function useAuditView(profileId: string) {
  const pushToast = useAppStore((state) => state.pushToast)
  const [report, setReport] = useState<SecurityReport | null>(null)
  const [history, setHistory] = useState<SecurityAuditSummary[]>([])
  const [severity, setSeverity] = useState('all')
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [fixTarget, setFixTarget] = useState<SecurityFinding | null>(null)
  const [fixing, setFixing] = useState(false)
  const [fixError, setFixError] = useState<string | null>(null)
  const [fixOutput, setFixOutput] = useState<string | null>(null)

  const loadHistory = useCallback(async () => {
    try {
      const entries = await securityService.list(profileId, 20)
      setHistory(entries)
      if (entries.length > 0) {
        const latest = await securityService.get(entries[0].id)
        if (latest) setReport(latest)
      }
    } catch (err) {
      setError(String(err))
    }
  }, [profileId])

  useEffect(() => {
    void loadHistory()
  }, [loadHistory])

  const runAudit = async () => {
    setLoading(true)
    setError(null)
    try {
      const result = await securityService.run(profileId)
      setReport(result)
      const entries = await securityService.list(profileId, 20)
      setHistory(entries)
      pushToast(
        'success',
        `Audit completed · score ${result.score}/100 · ${result.findings.length} findings`,
      )
    } catch (err) {
      const message = String(err)
      setError(message)
      pushToast('error', message)
    } finally {
      setLoading(false)
    }
  }

  const applyFix = async () => {
    if (!fixTarget) return
    setFixing(true)
    setFixError(null)
    setFixOutput(null)
    try {
      const result = await securityService.applyFix(profileId, fixTarget.id)
      setFixOutput(result.output)
      if (!result.ok) {
        setFixError(result.output)
        return
      }
      pushToast('success', 'Fix applied · re-running audit')
      setFixTarget(null)
      const refreshed = await securityService.run(profileId)
      setReport(refreshed)
      setHistory(await securityService.list(profileId, 20))
    } catch (err) {
      setFixError(String(err))
    } finally {
      setFixing(false)
    }
  }

  const findings = useMemo(() => {
    if (!report) return []
    return severity === 'all'
      ? report.findings
      : report.findings.filter((finding) => finding.severity === severity)
  }, [report, severity])

  return {
    applyFix,
    error,
    findings,
    fixError,
    fixOutput,
    fixTarget,
    fixing,
    history,
    loadHistory,
    loading,
    report,
    runAudit,
    setFixError,
    setFixOutput,
    setFixTarget,
    setReport,
    setSeverity,
    severity,
  }
}
