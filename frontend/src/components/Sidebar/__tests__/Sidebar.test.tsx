import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/useAppStore'
import type { Profile } from '@/types'
import { Sidebar } from '../Sidebar'

vi.mock('@/lib/actions', () => ({
  deleteProfile: vi.fn(),
  detectServerFor: vi.fn(),
  openMonitor: vi.fn(),
  openServices: vi.fn(),
  openTerminal: vi.fn(),
  profileNeedsCredentials: vi.fn(() => false),
  shareProfile: vi.fn(),
  importShare: vi.fn(),
}))

import { openTerminal } from '@/lib/actions'

const PROFILE: Profile = {
  id: 'p1',
  name: 'felizviajeapi',
  host: '165.232.158.163',
  port: 36280,
  username: 'root',
  authMethod: 'key',
  color: '#f97316',
  environment: 'production',
  tags: [],
  retry: { maxRetries: 2, baseDelayMs: 500, maxDelayMs: 5000, jitter: true },
  pool: { maxConnections: 4, acquireTimeoutMs: 10000, idleTimeoutSecs: 300 },
  keepaliveSecs: 30,
  connectTimeoutSecs: 10,
  elevated: true,
  createdAt: 0,
  updatedAt: 0,
  hasPassword: false,
  hasPrivateKey: true,
  hasPassphrase: false,
}

beforeEach(() => {
  vi.clearAllMocks()
  useAppStore.setState({
    profiles: [PROFILE],
    activeProfileId: 'p1',
    servers: {},
  })
})

describe('Sidebar', () => {
  it('renderiza la cabecera completa y las acciones dentro del footer', () => {
    const onEdit = vi.fn()
    render(<Sidebar onNew={vi.fn()} onEdit={onEdit} />)

    expect(screen.getByText('felizviajeapi')).toBeInTheDocument()
    expect(screen.getAllByText('PRD').length).toBeGreaterThan(0)
    expect(screen.getByText('root@165.232.158.163:36280')).toBeInTheDocument()

    const terminalButton = screen.getByTitle('Open terminal')
    expect(terminalButton.closest('footer')).toHaveClass('profile-card__footer')

    fireEvent.click(terminalButton)
    expect(openTerminal).toHaveBeenCalledWith(PROFILE)

    fireEvent.click(screen.getByTitle('Edit profile'))
    expect(onEdit).toHaveBeenCalledWith(PROFILE)
  })
})
