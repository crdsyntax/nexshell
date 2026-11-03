import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ShareConnectionModal } from '../ShareConnectionModal'
import { sharingService } from '@/services/sharing.service'
import type { Profile, ShareTarget } from '@/types'

vi.mock('@/services/sharing.service', async () => {
  const actual = await vi.importActual<typeof import('@/services/sharing.service')>(
    '@/services/sharing.service',
  )
  return {
    ...actual,
    sharingService: {
      prepare: vi.fn(),
      exportFile: vi.fn(),
      cancel: vi.fn(),
      pickSavePath: vi.fn(),
    },
  }
})

const sampleProfile: Profile = {
  id: 'prof-1',
  name: 'demo',
  host: '203.0.113.10',
  port: 22,
  username: 'root',
  authMethod: 'password',
  color: '#F97316',
  environment: 'production',
  tags: ['cliente'],
  retry: { maxRetries: 3, baseDelayMs: 250, maxDelayMs: 5000, jitter: true },
  pool: { maxConnections: 4, acquireTimeoutMs: 10000, idleTimeoutSecs: 300 },
  keepaliveSecs: 30,
  connectTimeoutSecs: 15,
  elevated: false,
  createdAt: 1760000000,
  updatedAt: 1760000000,
  hasPassword: true,
  hasPrivateKey: false,
  hasPassphrase: false,
}

describe('ShareConnectionModal', () => {
  const target: ShareTarget = {
    profile: sampleProfile,
    database: {
      engine: 'mariadb',
      host: 'localhost',
      port: 3306,
      user: 'root',
      socket: null,
    },
    dbPassword: 'db-secret-password',
  }

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(sharingService.cancel).mockResolvedValue(undefined)
  })

  it('hides secret toggles in metadata mode and shows them when secrets mode is enabled', () => {
    render(<ShareConnectionModal target={target} onClose={vi.fn()} />)

    expect(screen.queryByTestId('secrets-toggles')).toBeNull()

    const modeCheckbox = screen.getByTestId('toggle-secrets-mode')
    fireEvent.click(modeCheckbox)

    expect(screen.getByTestId('secrets-toggles')).toBeInTheDocument()
  })

  it('requires confirming passphrase saved before proceeding to step 3 and never re-shows passphrase on back', async () => {
    vi.mocked(sharingService.prepare).mockResolvedValue({
      shareId: '2f1c6b0a-9d4e-4c7a-8b21-3e5d7f9a1c42',
      passphrase: '7K2M-9Q4X-1B7N-5W8R-3T6Y-0H2J-4P9V-6X1C',
      mode: 'metadata',
      expiresAt: 1760086400,
      warnings: [],
    })

    render(<ShareConnectionModal target={target} onClose={vi.fn()} />)

    fireEvent.click(screen.getByTestId('btn-prepare-share'))

    await waitFor(() => {
      expect(screen.getByTestId('share-step-2')).toBeInTheDocument()
    })

    expect(screen.getByTestId('passphrase-display')).toHaveTextContent(
      '7K2M-9Q4X-1B7N-5W8R-3T6Y-0H2J-4P9V-6X1C',
    )

    const proceedBtn = screen.getByTestId('btn-proceed-save')
    expect(proceedBtn).toBeDisabled()

    fireEvent.click(screen.getByTestId('confirm-saved-passphrase'))
    expect(proceedBtn).not.toBeDisabled()

    fireEvent.click(screen.getByText('Atrás'))
    await waitFor(() => {
      expect(sharingService.cancel).toHaveBeenCalled()
      expect(screen.getByTestId('share-step-1')).toBeInTheDocument()
    })
    expect(screen.queryByTestId('passphrase-display')).toBeNull()
  })

  it('calls share_cancel and closes when user clicks Cancelar', async () => {
    const onClose = vi.fn()
    render(<ShareConnectionModal target={target} onClose={onClose} />)

    fireEvent.click(screen.getByText('Cancelar'))

    await waitFor(() => {
      expect(sharingService.cancel).toHaveBeenCalled()
      expect(onClose).toHaveBeenCalled()
    })
  })
})
