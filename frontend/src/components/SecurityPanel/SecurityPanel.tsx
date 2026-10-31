import { useState } from 'react'
import { useAppStore } from '@/store/useAppStore'
import {
  AlertIcon,
  ClockIcon,
  KeyIcon,
  SearchIcon,
  ShieldIcon,
} from '@/components/Icons'
import { AuditView } from './views/AuditView'
import { CronView } from './views/CronView'
import { ForensicsView } from './views/ForensicsView'
import { SudoersView } from './views/SudoersView'
import { IncidentView } from './views/IncidentView'
import { SshAccessView } from './views/SshAccessView'

interface SecurityPanelProps {
  profileId: string
}

type SecurityView = 'audit' | 'cron' | 'incident' | 'forensics' | 'sudoers' | 'ssh'

const SEC_TITLES: Record<SecurityView, string> = {
  audit: 'Security & hardening audit',
  cron: 'Scheduled jobs & persistence',
  incident: 'Incident response console',
  forensics: 'Forensics & access trail',
  sudoers: 'Sudoers & privileged access audit',
  ssh: 'SSH access & key management',
}

const SEC_SUBTITLES: Record<SecurityView, string> = {
  audit: 'Automated compliance parsing, hardening findings, exposed surfaces and remediation ledger.',
  cron: 'Crontabs, drop-ins, timers, at jobs and recent execution traces for this node.',
  incident: 'Temporary-directory processes, suspicious environments, established sockets and containment controls.',
  forensics: 'Login history, root artifacts, recursive searches and credential exposure.',
  sudoers: 'Automated compliance parsing, escalation surfaces, scheduled root timers, and authorization ledger.',
  ssh: 'Authorized keys, effective sshd policy and key-only access controls.',
}

export function SecurityPanel({ profileId }: SecurityPanelProps) {
  const profiles = useAppStore((state) => state.profiles)
  const profile = profiles.find((item) => item.id === profileId)
  const [view, setView] = useState<SecurityView>('audit')

  return (
    <div className="panel security-panel">
      <div className="sec-header">
        <div className="sec-header__main">
          <div className="sec-breadcrumb">
            <ShieldIcon size={12} />
            <span>HARDENING TELEMETRY</span>
            <span className="sec-breadcrumb__node">
              NODE: {(profile?.name ?? profileId).toUpperCase()} ({profile?.host ?? '—'})
            </span>
          </div>
          <h1 className="sec-title">{SEC_TITLES[view]}</h1>
          <p className="sec-sub">{SEC_SUBTITLES[view]}</p>
        </div>
        <div className="sec-header__actions">
          <div className="security-tabs">
            <button className={view === 'audit' ? 'is-active' : ''} onClick={() => setView('audit')}>
              <ShieldIcon size={12} /> Audit
            </button>
            <button className={view === 'cron' ? 'is-active' : ''} onClick={() => setView('cron')}>
              <ClockIcon size={12} /> Cron
            </button>
            <button className={view === 'incident' ? 'is-active' : ''} onClick={() => setView('incident')}>
              <AlertIcon size={12} /> Incidents
            </button>
            <button className={view === 'forensics' ? 'is-active' : ''} onClick={() => setView('forensics')}>
              <SearchIcon size={12} /> Forensics
            </button>
            <button className={view === 'sudoers' ? 'is-active' : ''} onClick={() => setView('sudoers')}>
              <ShieldIcon size={12} /> Sudoers
            </button>
            <button className={view === 'ssh' ? 'is-active' : ''} onClick={() => setView('ssh')}>
              <KeyIcon size={12} /> SSH keys
            </button>
          </div>
        </div>
      </div>

      {view === 'audit' && <AuditView profileId={profileId} />}
      {view === 'cron' && <CronView profileId={profileId} />}
      {view === 'incident' && <IncidentView profileId={profileId} />}
      {view === 'forensics' && <ForensicsView profileId={profileId} />}
      {view === 'sudoers' && <SudoersView profileId={profileId} />}
      {view === 'ssh' && <SshAccessView profileId={profileId} />}
    </div>
  )
}
