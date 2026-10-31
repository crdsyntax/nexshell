import { render, screen } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'

vi.mock('@/services/cron.service', () => ({
  cronService: {
    list: vi.fn(async () => ({
      hostname: 'host',
      generatedAt: 0,
      serviceState: 'active',
      entries: [],
      timers: [],
      atJobs: [],
      errors: [],
      recent: [],
    })),
    listBackups: vi.fn(async () => []),
    deleteEntry: vi.fn(),
    restoreBackup: vi.fn(),
  },
}))

import { CronView } from '../views/CronView'

describe('CronView', () => {
  it('muestra el botón de refresco y el estado del servicio', async () => {
    render(<CronView profileId="p1" />)
    expect(await screen.findByText(/Refresh cron/i)).toBeInTheDocument()
    expect(await screen.findByText(/cron service: active/i)).toBeInTheDocument()
  })
})
