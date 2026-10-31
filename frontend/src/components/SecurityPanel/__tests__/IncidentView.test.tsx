import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/services/incident.service', () => ({
  incidentService: {
    scan: vi.fn(async () => ({
      hostname: 'host',
      generatedAt: 0,
      processes: [],
      files: [],
      envHits: [],
      connections: [],
      authorizedKeys: [],
      units: [],
      shellHistory: [],
      containers: [],
    })),
    kill: vi.fn(),
    quarantine: vi.fn(),
    blockIp: vi.fn(),
  },
}))

import { IncidentView } from '../views/IncidentView'

describe('IncidentView', () => {
  it('muestra el escaneo y los contadores', async () => {
    render(<IncidentView profileId="p1" />)
    expect(await screen.findByText(/Escanear host/i)).toBeInTheDocument()
    expect(await screen.findByText(/Procesos desde directorios temporales/i)).toBeInTheDocument()
  })
})
