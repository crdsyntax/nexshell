import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Fail2banReport } from '@/types'

vi.mock('@/services/fail2ban.service', () => ({
  fail2banService: {
    report: vi.fn(),
    run: vi.fn(),
  },
}))

vi.mock('@/lib/netinfo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/netinfo')>()
  return { ...actual, fetchPublicIp: vi.fn() }
})

import { fail2banService } from '@/services/fail2ban.service'
import { fetchPublicIp } from '@/lib/netinfo'
import { Fail2banView } from '../Fail2banView'

const REPORT: Fail2banReport = {
  hostname: 'vps-1',
  installed: true,
  active: true,
  version: 'Fail2Ban v1.0.2',
  canManage: true,
  jails: ['sshd', 'nginx-http-auth'],
  sshd: {
    name: 'sshd',
    enabled: true,
    currentlyFailed: 2,
    totalFailed: 41,
    currentlyBanned: 1,
    totalBanned: 3,
    banned: ['203.0.113.5'],
    maxretry: 5,
    findtime: '10m',
    bantime: '1h',
    ignoreip: ['127.0.0.1/8', '::1'],
  },
  warnings: [],
  raw: ['Status for the jail: sshd'],
  generatedAt: 0,
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  vi.mocked(fail2banService.report).mockResolvedValue(REPORT)
  vi.mocked(fail2banService.run).mockResolvedValue({
    ok: true,
    action: 'unban',
    output: '1',
  })
  vi.mocked(fetchPublicIp).mockResolvedValue('198.51.100.7')
})

describe('Fail2banView', () => {
  it('muestra el jail sshd y permite desbloquear una IP', async () => {
    render(<Fail2banView profileId="p1" />)

    expect(await screen.findByText('203.0.113.5')).toBeInTheDocument()
    expect(screen.getAllByText('41').length).toBeGreaterThan(0)
    expect(screen.getByText('10m')).toBeInTheDocument()

    fireEvent.click(screen.getByRole('button', { name: /Desbloquear/i }))

    await waitFor(() =>
      expect(fail2banService.run).toHaveBeenCalledWith('p1', {
        action: 'unban',
        ip: '203.0.113.5',
      }),
    )
  })

  it('instala fail2ban con la lista de IPs ignoradas', async () => {
    vi.mocked(fail2banService.report).mockResolvedValue({
      ...REPORT,
      installed: false,
      active: false,
      jails: [],
      sshd: null,
    })
    render(<Fail2banView profileId="p1" />)

    fireEvent.click(await screen.findByRole('button', { name: /Instalar y activar/i }))

    await waitFor(() =>
      expect(fail2banService.run).toHaveBeenCalledWith('p1', {
        action: 'install',
        ignoreIp: '127.0.0.1/8 ::1',
      }),
    )
  })

  it('añade mi IP a las direcciones ignoradas', async () => {
    render(<Fail2banView profileId="p1" />)

    fireEvent.click(await screen.findByRole('button', { name: /Añadir mi IP/i }))

    await waitFor(() =>
      expect(screen.getByDisplayValue(/198\.51\.100\.7/)).toBeInTheDocument(),
    )
    expect(fetchPublicIp).toHaveBeenCalledWith('auto')
  })
})
