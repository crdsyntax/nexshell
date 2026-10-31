import { useState } from 'react'
import { ChevronDownIcon } from '@/components/Icons'
import type { ServiceStatus, WebServiceInfo } from '@/types'

interface ServiceChipProps {
  service: WebServiceInfo
  status?: ServiceStatus
  selected: boolean
  pinned: boolean
  onSelect: () => void
  onPin: () => void
}

function shortVersion(version: string): string {
  const match = version.match(/(\d+\.\d+\.\d+)/)
  return match?.[1] ?? version
}

export function ServiceChip({
  service,
  status,
  selected,
  pinned,
  onSelect,
  onPin,
}: ServiceChipProps) {
  const [hovered, setHovered] = useState(false)
  const open = hovered || pinned
  const stateLabel = !service.installed
    ? 'not installed'
    : status?.state ?? (service.active ? 'active' : 'inactive')
  const dotClass = !service.installed
    ? 'is-missing'
    : status?.active || service.active
      ? 'is-online'
      : 'is-offline'

  return (
    <div
      className="service-chip-wrap"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        className={`service-chip ${selected ? 'is-selected' : ''} ${
          service.installed ? '' : 'is-missing'
        }`}
        aria-expanded={open}
        onClick={() => {
          onSelect()
          onPin()
        }}
        onFocus={() => setHovered(true)}
        onBlur={() => setHovered(false)}
      >
        <span className={`chip-dot ${dotClass}`} />
        <span className="chip-name">{service.name}</span>
        <span className={`chip-state ${dotClass}`}>{stateLabel}</span>
        {service.installed && service.version && (
          <span className="chip-version">{shortVersion(service.version)}</span>
        )}
        <ChevronDownIcon size={11} />
      </button>

      {open && (
        <div className="service-chip-popover" role="tooltip">
          <div className="chip-popover__head">
            <strong>{service.name}</strong>
            <span
              className={`status-chip ${
                !service.installed
                  ? 'is-missing'
                  : status?.active || service.active
                    ? 'is-online'
                    : 'is-offline'
              }`}
            >
              {stateLabel}
            </span>
          </div>
          <div className="chip-popover__grid">
            <span>Version</span>
            <strong className="mono">
              {service.installed ? service.version || '—' : 'not installed'}
            </strong>
            <span>Binary</span>
            <strong className="mono">{service.binary || '—'}</strong>
            <span>Unit</span>
            <strong className="mono">{service.serviceUnit}</strong>
            <span>PID</span>
            <strong className="mono">{status?.pid ?? '—'}</strong>
            <span>Config</span>
            <strong className="mono">{service.configFile}</strong>
            <span>Root</span>
            <strong className="mono">{service.configRoot}</strong>
            <span>Log</span>
            <strong className="mono">{service.logFile}</strong>
          </div>
          {!service.installed && (
            <p className="chip-popover__hint">
              The binary was not found on this host. Install it and press Rescan.
            </p>
          )}
          {service.installed && (
            <p className="chip-popover__hint">
              Hover for a preview · click to pin this panel
            </p>
          )}
        </div>
      )}
    </div>
  )
}
