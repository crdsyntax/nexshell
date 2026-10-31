import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/services/security.service', () => ({
  securityService: {
    sudoers: vi.fn(async () => ({
      hostname: 'host',
      generatedAt: 0,
      groups: [{ name: 'wheel', gid: '10', members: ['root'] }],
      rules: [
        {
          principal: 'root',
          host: 'ALL',
          runas: 'ALL',
          nopasswd: false,
          commands: 'ALL',
          source: '/etc/sudoers',
          raw: 'root ALL=(ALL) ALL',
        },
      ],
      accounts: [],
      rootAccounts: ['root'],
      configOk: true,
      configOutput: '',
    })),
    removeSudoersRule: vi.fn(),
    setUserLock: vi.fn(),
    accountOrigin: vi.fn(),
  },
}))

import { SudoersView } from '../views/SudoersView'

describe('SudoersView', () => {
  it('muestra reglas y estado de visudo', async () => {
    render(<SudoersView profileId="p1" />)
    expect(await screen.findByText(/Leer sudoers/i)).toBeInTheDocument()
    expect(await screen.findByText(/visudo -c: syntax valid/i)).toBeInTheDocument()
    expect((await screen.findAllByText('root')).length).toBeGreaterThan(0)
  })
})
