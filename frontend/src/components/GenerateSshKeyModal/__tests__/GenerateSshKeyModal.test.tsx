import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { sshService } from '@/services/ssh.service'
import { GenerateSshKeyModal } from '../GenerateSshKeyModal'

vi.mock('@/services/ssh.service', () => ({
  sshService: {
    generateKey: vi.fn(),
    saveKeyPair: vi.fn(),
  },
}))

vi.mock('@tauri-apps/plugin-dialog', () => ({
  save: vi.fn(),
}))

describe('GenerateSshKeyModal', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('does not render when open is false', () => {
    render(<GenerateSshKeyModal open={false} onClose={() => {}} />)
    expect(screen.queryByText('Generador de par de claves SSH')).toBeNull()
  })

  it('renders form and switches algorithms', () => {
    render(<GenerateSshKeyModal open={true} onClose={() => {}} />)

    expect(screen.getByText('Generador de par de claves SSH')).toBeDefined()
    expect(screen.getByText(/ED25519 \(Recomendado\)/)).toBeDefined()
    expect(screen.getByText('RSA')).toBeDefined()

    // Switch to RSA
    fireEvent.click(screen.getByText('RSA'))
    expect(screen.getByText('Tamaño de clave RSA')).toBeDefined()
    expect(screen.getByText('4096 bits (Recomendado)')).toBeDefined()
    expect(screen.getByText('2048 bits')).toBeDefined()

    // Switch back to ED25519
    fireEvent.click(screen.getByText(/ED25519 \(Recomendado\)/))
    expect(screen.queryByText('Tamaño de clave RSA')).toBeNull()
  })

  it('validates mismatched passphrases before submitting', async () => {
    render(<GenerateSshKeyModal open={true} onClose={() => {}} />)

    const passphraseInputs = screen.getAllByPlaceholderText(/contraseña/i)
    fireEvent.change(passphraseInputs[0], { target: { value: 'pass123' } })

    const confirmInput = screen.getByPlaceholderText('Repetir contraseña')
    fireEvent.change(confirmInput, { target: { value: 'different' } })

    const submitBtn = screen.getByRole('button', { name: /Generar par de claves/i })
    fireEvent.click(submitBtn)

    expect(await screen.findByText('Las frases de contraseña no coinciden.')).toBeDefined()
    expect(sshService.generateKey).not.toHaveBeenCalled()
  })

  it('generates key pair and displays result view with public key and fingerprint', async () => {
    const mockKeyPair = {
      algorithm: 'ed25519',
      comment: 'nexshell@local',
      publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIG6LUjxAbFaDqtGOrTaxB2fOaRBZ2BVnob5ILoCj7zZs nexshell@local',
      privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nbW9jaw==\n-----END OPENSSH PRIVATE KEY-----\n',
      fingerprint: 'SHA256:5t18xbo+h4QgC2lIzmHY0ktJ7ZLyo7zo0EU/G1EieRw',
      savedPrivatePath: '/home/user/.ssh/id_ed25519',
      savedPublicPath: '/home/user/.ssh/id_ed25519.pub',
    }

    vi.mocked(sshService.generateKey).mockResolvedValueOnce(mockKeyPair)

    const handleSuccess = vi.fn()
    render(<GenerateSshKeyModal open={true} onClose={() => {}} onSuccess={handleSuccess} />)

    const submitBtn = screen.getByRole('button', { name: /Generar par de claves/i })
    fireEvent.click(submitBtn)

    await waitFor(() => {
      expect(sshService.generateKey).toHaveBeenCalledWith({
        algorithm: 'ed25519',
        bits: undefined,
        comment: 'nexshell@local',
        passphrase: undefined,
        destinationPath: '~/.ssh/id_ed25519',
      })
    })

    expect(await screen.findByText('¡Par de claves SSH generado con éxito!')).toBeDefined()
    expect(screen.getByText('SHA256:5t18xbo+h4QgC2lIzmHY0ktJ7ZLyo7zo0EU/G1EieRw')).toBeDefined()
    expect(screen.getByText('/home/user/.ssh/id_ed25519')).toBeDefined()
    expect(handleSuccess).toHaveBeenCalledWith(mockKeyPair)

    // Private key is initially masked
    expect(screen.getByText(/Clave privada oculta por seguridad/)).toBeDefined()

    // Reveal private key
    fireEvent.click(screen.getByText('Mostrar clave privada'))
    expect(screen.getByText('Ocultar')).toBeDefined()
    expect(screen.getByDisplayValue((val) => val.includes('BEGIN OPENSSH PRIVATE KEY'))).toBeDefined()
  })

  it('triggers onUseInProfile callback when action button is clicked', async () => {
    const mockKeyPair = {
      algorithm: 'ed25519',
      comment: 'nexshell@local',
      publicKey: 'ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAI mock',
      privateKey: '-----BEGIN OPENSSH PRIVATE KEY-----\nmock\n-----END OPENSSH PRIVATE KEY-----\n',
      fingerprint: 'SHA256:mockfp',
    }

    vi.mocked(sshService.generateKey).mockResolvedValueOnce(mockKeyPair)

    const handleUse = vi.fn()
    const handleClose = vi.fn()

    render(
      <GenerateSshKeyModal
        open={true}
        onClose={handleClose}
        onUseInProfile={handleUse}
      />
    )

    fireEvent.click(screen.getByRole('button', { name: /Generar par de claves/i }))

    const useBtn = await screen.findByRole('button', { name: /Usar en esta conexión/i })
    fireEvent.click(useBtn)

    expect(handleUse).toHaveBeenCalledWith(mockKeyPair)
    expect(handleClose).toHaveBeenCalled()
  })
})
