import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { FirewallReport } from '@/types'

vi.mock('@/services/firewall.service', () => ({
  firewallService: {
    report: vi.fn(),
    run: vi.fn(),
  },
}))

vi.mock('@/lib/netinfo', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/netinfo')>()
  return { ...actual, fetchPublicIp: vi.fn() }
})

import { firewallService } from '@/services/firewall.service'
import { fetchPublicIp } from '@/lib/netinfo'
import { FirewallPanel } from '../FirewallPanel'

const REPORT: FirewallReport = {
  hostname: 'vps-1',
  os: 'ubuntu 24.04',
  packageManager: '/usr/bin/apt-get',
  backend: 'ufw',
  installed: true,
  active: true,
  canManage: true,
  defaultIncoming: 'deny (incoming)',
  defaultOutgoing: 'allow (outgoing)',
  sshPorts: [22, 2222],
  sshAllowed: [22, 2222],
  rules: [
    {
      id: '1',
      action: 'allow',
      port: '22',
      protocol: 'tcp',
      from: 'Anywhere',
      comment: '2shell ssh',
    },
    {
      id: '2',
      action: 'deny',
      port: '3306',
      protocol: 'tcp',
      from: 'Anywhere',
      comment: '',
    },
  ],
  warnings: [],
  raw: ['Status: active'],
  generatedAt: 0,
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(window, 'confirm').mockReturnValue(true)
  vi.mocked(firewallService.report).mockResolvedValue(REPORT)
  vi.mocked(firewallService.run).mockResolvedValue({
    ok: true,
    action: 'enable',
    output: 'Firewall is active',
  })
  vi.mocked(fetchPublicIp).mockResolvedValue('203.0.113.7')
})

describe('FirewallPanel', () => {
  it('muestra backend, estado, puertos SSH y reglas', async () => {
    render(<FirewallPanel profileId="p1" />)

    expect(await screen.findByText('ufw')).toBeInTheDocument()
    expect(screen.getByText('ACTIVO')).toBeInTheDocument()
    expect(screen.getByText('deny (incoming)')).toBeInTheDocument()
    expect(screen.getAllByText('22').length).toBeGreaterThan(0)
    expect(screen.getByText('3306')).toBeInTheDocument()
  })

  it('activa el firewall solo tras confirmar', async () => {
    vi.mocked(firewallService.report).mockResolvedValue({
      ...REPORT,
      active: false,
      sshAllowed: [],
      rules: [],
    })
    render(<FirewallPanel profileId="p1" />)

    fireEvent.click(await screen.findByRole('button', { name: /Activar firewall/i }))

    await waitFor(() =>
      expect(firewallService.run).toHaveBeenCalledWith('p1', { action: 'enable' }),
    )
    expect(window.confirm).toHaveBeenCalled()
  })

  it('edita una regla y restringe el origen a una IPv4', async () => {
    render(<FirewallPanel profileId="p1" />)

    fireEvent.click((await screen.findAllByTitle('Editar regla'))[0])
    expect(screen.getByText('Editar regla #1')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Origen'), {
      target: { value: 'ipv4' },
    })
    fireEvent.change(screen.getByLabelText('Dirección / CIDR'), {
      target: { value: '203.0.113.10' },
    })
    fireEvent.click(screen.getByRole('button', { name: /Guardar/i }))

    await waitFor(() =>
      expect(firewallService.run).toHaveBeenCalledWith('p1', {
        action: 'update_rule',
        ruleId: '1',
        port: '22',
        protocol: 'tcp',
        source: '203.0.113.10',
        ruleAction: 'allow',
        previous: {
          action: 'allow',
          port: '22',
          protocol: 'tcp',
          source: 'any',
        },
      }),
    )
  })

  it('rellena el origen con mi IP pública', async () => {
    render(<FirewallPanel profileId="p1" />)

    fireEvent.click(await screen.findByRole('button', { name: /Usar mi IP/i }))

    await waitFor(() =>
      expect(screen.getByLabelText('Dirección / CIDR')).toHaveValue('203.0.113.7'),
    )
    expect(fetchPublicIp).toHaveBeenCalledWith('auto')
  })

  it('impide denegar el puerto SSH', async () => {
    render(<FirewallPanel profileId="p1" />)

    fireEvent.change(await screen.findByLabelText('Acción'), {
      target: { value: 'deny' },
    })
    fireEvent.change(screen.getByLabelText('Puerto'), { target: { value: '22' } })
    fireEvent.click(screen.getByRole('button', { name: /Añadir/i }))

    expect(
      await screen.findByText(/No se puede denegar el puerto SSH 22/),
    ).toBeInTheDocument()
    expect(firewallService.run).not.toHaveBeenCalled()
  })
})
