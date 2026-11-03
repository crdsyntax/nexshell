import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ImportShareModal } from '../ImportShareModal'
import { sharingService } from '@/services/sharing.service'
import { useAppStore } from '@/store/useAppStore'

vi.mock('@/services/sharing.service', async () => {
  const actual = await vi.importActual<typeof import('@/services/sharing.service')>(
    '@/services/sharing.service',
  )
  return {
    ...actual,
    sharingService: {
      inspect: vi.fn(),
      unlock: vi.fn(),
      importBundle: vi.fn(),
      discard: vi.fn(),
      pickOpenPath: vi.fn(),
    },
  }
})

vi.mock('@/lib/actions', () => ({
  refreshProfiles: vi.fn(() => Promise.resolve()),
  openTerminal: vi.fn(),
}))

describe('ImportShareModal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(sharingService.discard).mockResolvedValue(undefined)
    useAppStore.setState({
      profiles: [],
      pendingDbAuth: {},
    })
  })

  it('shows generic error on bad passphrase and allows retry', async () => {
    vi.mocked(sharingService.inspect).mockResolvedValue({
      format: '2shell-share',
      version: 1,
      shareId: '2f1c6b0a-9d4e-4c7a-8b21-3e5d7f9a1c42',
      createdAt: 1760000000,
      expiresAt: 1760086400,
      mode: 'secrets',
      bytes: 1200,
      expired: false,
      needsPassphrase: true,
    })
    vi.mocked(sharingService.unlock).mockRejectedValue(
      new Error('SHARE_BAD_PASSPHRASE: invalid passphrase or corrupted file'),
    )

    render(<ImportShareModal open={true} onClose={vi.fn()} />)

    const pathInput = screen.getByPlaceholderText('Ruta al archivo .2share')
    fireEvent.change(pathInput, { target: { value: '/tmp/demo.2share' } })
    fireEvent.click(screen.getByTestId('btn-inspect-share'))

    await waitFor(() => {
      expect(screen.getByTestId('share-header-view')).toBeInTheDocument()
    })

    const passInput = screen.getByTestId('passphrase-input')
    fireEvent.change(passInput, {
      target: { value: '0123456789ABCDEFGHJKMNPQRSTVWXYZ' },
    })

    fireEvent.click(screen.getByTestId('btn-unlock-share'))

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(
        'Frase incorrecta o archivo alterado',
      )
    })
    expect(screen.getByTestId('btn-unlock-share')).not.toBeDisabled()
  })

  it('defaults conflict policy to skip, does not render secret values, and shows Completar for needsCredentials', async () => {
    vi.mocked(sharingService.inspect).mockResolvedValue({
      format: '2shell-share',
      version: 1,
      shareId: '2f1c6b0a-9d4e-4c7a-8b21-3e5d7f9a1c42',
      createdAt: 1760000000,
      expiresAt: 1760086400,
      mode: 'metadata',
      bytes: 950,
      expired: false,
      needsPassphrase: true,
    })
    vi.mocked(sharingService.unlock).mockResolvedValue({
      shareId: '2f1c6b0a-9d4e-4c7a-8b21-3e5d7f9a1c42',
      createdAt: 1760000000,
      expiresAt: 1760086400,
      mode: 'metadata',
      origin: { app: '2shell', version: '0.2.0', platform: 'linux' },
      connections: [
        {
          shareEntryId: '47643f34-d009-5253-8ec8-665ac82948b0',
          profile: {
            name: 'demo',
            host: '203.0.113.10',
            port: 22,
            username: 'root',
            authMethod: 'password',
            environment: 'production',
            color: '#F97316',
            tags: ['cliente'],
            keepaliveSecs: 30,
            connectTimeoutSecs: 15,
            retry: { maxRetries: 3, baseDelayMs: 250, maxDelayMs: 5000, jitter: true },
            pool: { maxConnections: 4, acquireTimeoutMs: 10000, idleTimeoutSecs: 300 },
            elevated: false,
          },
          hasSshPassword: false,
          hasPrivateKey: false,
          hasPassphrase: false,
          hasDatabasePassword: false,
          needsCredentials: true,
          keyPathHint: null,
          hostKey: null,
          database: {
            engine: 'mariadb',
            host: 'localhost',
            port: 3306,
            user: 'root',
            socket: null,
          },
          conflicts: [],
        },
      ],
    })
    vi.mocked(sharingService.importBundle).mockResolvedValue({
      shareId: '2f1c6b0a-9d4e-4c7a-8b21-3e5d7f9a1c42',
      mode: 'metadata',
      imported: [
        {
          shareEntryId: '47643f34-d009-5253-8ec8-665ac82948b0',
          profileId: 'prof-new-1',
          action: 'created',
        },
      ],
      skipped: [],
      needsCredentials: ['prof-new-1'],
      hostKeys: [],
      ephemeralDatabase: {
        profileId: 'prof-new-1',
        engine: 'mariadb',
        host: 'localhost',
        port: 3306,
        user: 'root',
        password: 'ephemeral-db-password',
        expiresAt: Math.floor(Date.now() / 1000) + 300,
      },
    })

    render(<ImportShareModal open={true} onClose={vi.fn()} />)

    const pathInput = screen.getByPlaceholderText('Ruta al archivo .2share')
    fireEvent.change(pathInput, { target: { value: '/tmp/demo.2share' } })
    fireEvent.click(screen.getByTestId('btn-inspect-share'))

    await waitFor(() => expect(screen.getByTestId('share-header-view')).toBeInTheDocument())

    fireEvent.change(screen.getByTestId('passphrase-input'), {
      target: { value: '0123456789ABCDEFGHJKMNPQRSTVWXYZ' },
    })
    fireEvent.click(screen.getByTestId('btn-unlock-share'))

    await waitFor(() => expect(screen.getByTestId('import-stage-preview')).toBeInTheDocument())

    const selectPolicy = screen.getByTestId('select-conflict-policy') as HTMLSelectElement
    expect(selectPolicy.value).toBe('skip')
    expect(screen.getByText('Sin credenciales')).toBeInTheDocument()

    fireEvent.click(screen.getByTestId('btn-confirm-import'))

    await waitFor(() => expect(screen.getByTestId('import-stage-report')).toBeInTheDocument())
    expect(screen.getByTestId('btn-complete-prof-new-1')).toBeInTheDocument()
    expect(window.localStorage.getItem('pendingDbAuth')).toBeNull()
    expect(useAppStore.getState().pendingDbAuth['prof-new-1']?.password).toBe(
      'ephemeral-db-password',
    )
  })
})
