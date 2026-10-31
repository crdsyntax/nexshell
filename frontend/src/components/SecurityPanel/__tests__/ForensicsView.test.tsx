import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/services/forensics.service', () => ({
  forensicsService: {
    sessions: vi.fn(async () => []),
    auth: vi.fn(async () => []),
    artifacts: vi.fn(async () => []),
    search: vi.fn(async () => []),
    secrets: vi.fn(async () => []),
  },
}))

import { ForensicsView } from '../views/ForensicsView'

describe('ForensicsView', () => {
  it('muestra las secciones de sesiones e intentos', async () => {
    render(<ForensicsView profileId="p1" />)
    expect(await screen.findByText('Sesiones SSH')).toBeInTheDocument()
    expect(screen.getByText('Intentos SSH')).toBeInTheDocument()
    expect(await screen.findByText(/Sin sesiones/i)).toBeInTheDocument()
  })
})
