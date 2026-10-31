import { useMemo, useState } from 'react'
import { useAppStore } from '@/store/useAppStore'
import { copyToClipboard } from '@/lib/network'
import { classifyLogLine, stripAnsi } from '@/lib/logs'

export function useLogViewer(text: string) {
  const pushToast = useAppStore((state) => state.pushToast)
  const [onlyIssues, setOnlyIssues] = useState(false)

  const lines = useMemo(() => {
    const raw = stripAnsi(text ?? '')
    if (!raw.trim()) return []
    return raw.split('\n').map((line, index) => ({
      index,
      text: line,
      kind: classifyLogLine(line),
    }))
  }, [text])

  const issues = useMemo(
    () => lines.filter((line) => line.kind === 'error' || line.kind === 'stack'),
    [lines],
  )
  const errorCount = lines.filter((line) => line.kind === 'error').length
  const warnCount = lines.filter((line) => line.kind === 'warn').length
  const shown = onlyIssues ? issues : lines

  const copy = async (value: string, label: string) => {
    try {
      await copyToClipboard(value)
      pushToast('success', label)
    } catch (error) {
      pushToast('error', String(error))
    }
  }

  const copyIssues = () =>
    copy(issues.map((line) => line.text).join('\n'), 'Errores copiados')

  const copyAll = () => copy(lines.map((line) => line.text).join('\n'), 'Log copiado')

  return {
    lines,
    issues,
    shown,
    errorCount,
    warnCount,
    onlyIssues,
    setOnlyIssues,
    copy,
    copyIssues,
    copyAll,
  }
}
