import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/services/security.service', () => ({
  securityService: {
    list: vi.fn(async () => []),
    get: vi.fn(async () => null),
    run: vi.fn(),
    sudoers: vi.fn(),
    applyFix: vi.fn(),
    removeSudoersRule: vi.fn(),
    setUserLock: vi.fn(),
    accountOrigin: vi.fn(),
  },
}))

import { AuditView } from '../views/AuditView'

describe('AuditView', () => {
  it('muestra el estado vacío y el botón de auditoría', async () => {
    render(<AuditView profileId="p1" />)
    expect(await screen.findByText(/No security audit yet/i)).toBeInTheDocument()
    expect(screen.getByText(/Run security audit/i)).toBeInTheDocument()
  })
})
