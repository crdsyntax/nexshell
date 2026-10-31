import { useEffect, useState } from 'react'
import { auditService } from '@/services/audit.service'
import { useAppStore } from '@/store/useAppStore'
import {
  AlertIcon,
  ClockIcon,
  FileIcon,
  RefreshIcon,
  SearchIcon,
  TrashIcon,
  XIcon,
} from '@/components/Icons'
import type { ExecutionLog } from '@/types'

const CATEGORIES = [
  'connection',
  'terminal',
  'service',
  'process',
  'filesystem',
  'command',
  'profile',
  'detect',
  'database',
  'security',
  'cron',
  'ssh-access',
  'ssh',
  'monitor',
]

const STATUSES = ['success', 'failed', 'error']

function formatTime(timestamp: number): string {
  return new Date(timestamp * 1000).toLocaleString()
}

export function AuditPanel() {
  const profiles = useAppStore((state) => state.profiles)
  const pushToast = useAppStore((state) => state.pushToast)
  const [profileFilter, setProfileFilter] = useState('all')
  const [category, setCategory] = useState('all')
  const [status, setStatus] = useState('all')
  const [search, setSearch] = useState('')
  const [debouncedSearch, setDebouncedSearch] = useState('')
  const [logs, setLogs] = useState<ExecutionLog[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [dbPath, setDbPath] = useState('')
  const [detail, setDetail] = useState<ExecutionLog | null>(null)
  const [clearing, setClearing] = useState(false)
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    const timer = window.setTimeout(() => setDebouncedSearch(search), 300)
    return () => window.clearTimeout(timer)
  }, [search])

  useEffect(() => {
    auditService
      .dbPath()
      .then(setDbPath)
      .catch(() => setDbPath('unavailable'))
  }, [])

  useEffect(() => {
    let active = true
    setLoading(true)
    setError(null)
    auditService
      .list({
        profileId: profileFilter === 'all' ? undefined : profileFilter,
        category: category === 'all' ? undefined : category,
        status: status === 'all' ? undefined : status,
        search: debouncedSearch.trim() || undefined,
        limit: 300,
      })
      .then((entries) => {
        if (active) setLogs(entries)
      })
      .catch((err) => {
        if (active) setError(String(err))
      })
      .finally(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [profileFilter, category, status, debouncedSearch, nonce])

  const clearLogs = async () => {
    const scope =
      profileFilter === 'all'
        ? 'all execution logs'
        : `execution logs for the selected profile`
    if (!window.confirm(`Delete ${scope}? This cannot be undone.`)) return
    setClearing(true)
    try {
      const removed = await auditService.clear(
        profileFilter === 'all' ? undefined : profileFilter,
      )
      pushToast('success', `Deleted ${removed} log entr${removed === 1 ? 'y' : 'ies'}`)
      setNonce((value) => value + 1)
    } catch (err) {
      pushToast('error', String(err))
    } finally {
      setClearing(false)
    }
  }

  return (
    <div className="panel audit-panel">
      <div className="panel__header">
        <div>
          <div className="panel__eyebrow">
            <FileIcon size={14} /> audit trail
          </div>
          <h2>
            Execution log
            <span className="panel__sub">{logs.length} entries</span>
          </h2>
          <p className="panel__description">
            Connections, remote commands, terminals and destructive actions, persisted in
            SQLite.
          </p>
        </div>
        <div className="panel__actions">
          <button className="top-action" onClick={() => setNonce((value) => value + 1)}>
            <RefreshIcon size={14} /> Refresh
          </button>
          <button
            className="top-action"
            onClick={() => void clearLogs()}
            disabled={clearing || logs.length === 0}
            title="Delete the logs matching the current profile filter"
          >
            <TrashIcon size={14} /> {clearing ? 'Clearing…' : 'Clear logs'}
          </button>
        </div>
      </div>

      <div className="audit-filters">
        <label className="audit-filter">
          <span>Profile</span>
          <select value={profileFilter} onChange={(event) => setProfileFilter(event.target.value)}>
            <option value="all">All profiles</option>
            {profiles.map((profile) => (
              <option value={profile.id} key={profile.id}>
                {profile.name}
              </option>
            ))}
          </select>
        </label>
        <label className="audit-filter">
          <span>Category</span>
          <select value={category} onChange={(event) => setCategory(event.target.value)}>
            <option value="all">All</option>
            {CATEGORIES.map((item) => (
              <option value={item} key={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
        <label className="audit-filter">
          <span>Status</span>
          <select value={status} onChange={(event) => setStatus(event.target.value)}>
            <option value="all">All</option>
            {STATUSES.map((item) => (
              <option value={item} key={item}>
                {item}
              </option>
            ))}
          </select>
        </label>
        <label className="audit-filter audit-filter--search">
          <span>Search</span>
          <div className="input-with-action">
            <SearchIcon size={14} />
            <input
              value={search}
              onChange={(event) => setSearch(event.target.value)}
              placeholder="command, path, host…"
              spellCheck={false}
            />
          </div>
        </label>
      </div>

      {error && (
        <div className="inline-alert inline-alert--error">
          <AlertIcon size={15} />
          <span>{error}</span>
        </div>
      )}

      {loading ? (
        <div className="large-files-loading">
          <span className="spinner" /> Loading execution log…
        </div>
      ) : logs.length === 0 ? (
        <div className="large-files-empty">
          <ClockIcon size={20} />
          <strong>No execution log entries</strong>
          <p>
            Commands and actions will appear here as you use terminals, services, process
            controls and the filesystem panel.
          </p>
        </div>
      ) : (
        <div className="audit-table">
          <div className="audit-row audit-row--head">
            <span>TIME</span>
            <span>PROFILE</span>
            <span>CATEGORY</span>
            <span>ACTION</span>
            <span>TARGET / COMMAND</span>
            <span>STATUS</span>
            <span>EXIT</span>
            <span>DURATION</span>
          </div>
          {logs.map((log) => (
            <button
              className="audit-row"
              key={log.id}
              onClick={() => setDetail(log)}
              title={log.error ?? log.command ?? log.target ?? ''}
            >
              <span className="audit-time">{formatTime(log.timestamp)}</span>
              <span className="audit-profile">
                {log.profileName ?? log.profileId ?? '—'}
              </span>
              <span className={`audit-category cat-${log.category}`}>{log.category}</span>
              <span className="audit-action">{log.action}</span>
              <span className="audit-target mono">
                {log.target ?? log.command ?? '—'}
              </span>
              <span className={`audit-status status-${log.status}`}>{log.status}</span>
              <span className="mono audit-exit">{log.exitCode ?? '—'}</span>
              <span className="mono audit-duration">
                {log.durationMs !== null ? `${log.durationMs} ms` : '—'}
              </span>
            </button>
          ))}
        </div>
      )}

      <footer className="audit-footer">
        <span title={dbPath}>SQLite: {dbPath}</span>
        <span>Newest 300 entries loaded · retention 10,000</span>
      </footer>

      {detail && (
        <div
          className="modal-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setDetail(null)
          }}
        >
          <div className="modal modal--compact" role="dialog" aria-modal="true">
            <header className="modal__header">
              <div>
                <h2>Execution log #{detail.id}</h2>
                <p>{formatTime(detail.timestamp)}</p>
              </div>
              <button className="icon-button" onClick={() => setDetail(null)} title="Close">
                <XIcon size={16} />
              </button>
            </header>
            <div className="modal__body">
              <div className="property-grid">
                <span>Profile</span>
                <strong>{detail.profileName ?? detail.profileId ?? '—'}</strong>
                <span>Category</span>
                <strong>{detail.category}</strong>
                <span>Action</span>
                <strong>{detail.action}</strong>
                <span>Status</span>
                <strong className={`audit-status status-${detail.status}`}>
                  {detail.status}
                </strong>
                <span>Target</span>
                <strong className="mono">{detail.target ?? '—'}</strong>
                <span>Exit code</span>
                <strong className="mono">{detail.exitCode ?? '—'}</strong>
                <span>Duration</span>
                <strong className="mono">
                  {detail.durationMs !== null ? `${detail.durationMs} ms` : '—'}
                </strong>
              </div>

              {detail.command && (
                <div className="audit-detail-section">
                  <span>Command</span>
                  <pre>{detail.command}</pre>
                </div>
              )}
              {detail.output && (
                <div className="audit-detail-section">
                  <span>Output</span>
                  <pre>{detail.output}</pre>
                </div>
              )}
              {detail.error && (
                <div className="audit-detail-section is-error">
                  <span>Error</span>
                  <pre>{detail.error}</pre>
                </div>
              )}
              {detail.metadata != null && (
                <div className="audit-detail-section">
                  <span>Metadata</span>
                  <pre>{JSON.stringify(detail.metadata, null, 2)}</pre>
                </div>
              )}
            </div>
            <footer className="modal__footer">
              <button className="ghost-button" onClick={() => setDetail(null)}>
                Close
              </button>
            </footer>
          </div>
        </div>
      )}
    </div>
  )
}
