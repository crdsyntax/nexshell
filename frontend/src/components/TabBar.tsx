import { useAppStore } from '@/store/useAppStore'
import { ActivityIcon, FileIcon, ServerIcon, TerminalIcon, XIcon } from '@/components/Icons'
import type { TabKind } from '@/types'

function TabIcon({ kind }: { kind: TabKind }) {
  if (kind === 'monitor') return <ActivityIcon size={14} />
  if (kind === 'services') return <ServerIcon size={14} />
  if (kind === 'audit') return <FileIcon size={14} />
  return <TerminalIcon size={14} />
}

export function TabBar() {
  const tabs = useAppStore((state) => state.tabs)
  const activeTabId = useAppStore((state) => state.activeTabId)
  const activateTab = useAppStore((state) => state.activateTab)
  const closeTab = useAppStore((state) => state.closeTab)

  if (tabs.length === 0) {
    return <div className="tab-bar tab-bar--empty">workspace</div>
  }

  return (
    <div className="tab-bar" role="tablist">
      {tabs.map((tab) => (
        <div
          key={tab.id}
          role="tab"
          aria-selected={tab.id === activeTabId}
          className={`workspace-tab ${tab.id === activeTabId ? 'is-active' : ''}`}
          onClick={() => activateTab(tab.id)}
          onAuxClick={(event) => {
            if (event.button === 1) closeTab(tab.id)
          }}
          title={tab.error ?? tab.title}
        >
          <span className="workspace-tab__icon">
            <TabIcon kind={tab.kind} />
          </span>
          <span className="workspace-tab__title">{tab.title}</span>
          <span className={`tab-status tab-status--${tab.status}`} />
          <button
            className="workspace-tab__close"
            onClick={(event) => {
              event.stopPropagation()
              closeTab(tab.id)
            }}
            title="Close tab"
          >
            <XIcon size={12} />
          </button>
        </div>
      ))}
    </div>
  )
}
