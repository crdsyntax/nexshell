import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/services/ssh.service', () => ({
  sshService: {
    keys: vi.fn(async () => []),
    config: vi.fn(async () => ({
      pubkeyAuthentication: 'yes',
      passwordAuthentication: 'no',
      kbdInteractiveAuthentication: 'no',
      permitRootLogin: 'prohibit-password',
      configTestOk: true,
      dropinPresent: true,
      dropinPath: '/etc/ssh/sshd_config.d/00-2shell-key-only.conf',
      output: '',
    })),
    addKey: vi.fn(),
    removeKey: vi.fn(),
    setKeyOnly: vi.fn(),
  },
}))

import { SshAccessView } from '../views/SshAccessView'

describe('SshAccessView', () => {
  it('muestra claves y configuración de sshd', async () => {
    render(<SshAccessView profileId="p1" />)
    expect(await screen.findByRole('heading', { name: /Authorized keys/i })).toBeInTheDocument()
    expect(await screen.findByText('Password authentication')).toBeInTheDocument()
    expect(await screen.findByText(/No authorized keys found/i)).toBeInTheDocument()
  })
})
