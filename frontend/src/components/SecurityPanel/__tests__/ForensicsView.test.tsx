import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('@/services/forensics.service', () => ({
  forensicsService: {
    sessions: vi.fn(async () => []),
    auth: vi.fn(async () => [
      {
        timestamp: 'Nov 05 18:12:15',
        user: 'root',
        from: '190.142.109.102',
        method: 'publickey',
        status: 'success',
        kind: 'accepted',
        detail: 'Accepted publickey for root',
      },
      {
        timestamp: 'Nov 05 18:07:39',
        user: 'admin',
        from: '2.57.121.25',
        method: '—',
        status: 'failed',
        kind: 'invalid-user',
        detail: 'Failed password for invalid user admin',
      },
      {
        timestamp: 'Nov 05 17:48:33',
        user: 'ubuntu',
        from: '115.190.229.117',
        method: '—',
        status: 'failed',
        kind: 'bad-password',
        detail: 'Failed password for ubuntu',
      },
    ]),
    artifacts: vi.fn(async () => []),
    search: vi.fn(async () => []),
    secrets: vi.fn(async () => []),
  },
}))

vi.mock('@/services/fail2ban.service', () => ({
  fail2banService: {
    report: vi.fn(async () => ({
      hostname: 'test-host',
      installed: true,
      active: true,
      version: '0.11.2',
      canManage: true,
      jails: ['sshd'],
      sshd: {
        name: 'sshd',
        enabled: true,
        currentlyFailed: 2,
        totalFailed: 10,
        currentlyBanned: 1,
        totalBanned: 5,
        banned: ['2.57.121.25'],
        maxretry: 3,
        findtime: '10m',
        bantime: '1h',
        ignoreip: [],
      },
      warnings: [],
      raw: [],
      generatedAt: Date.now(),
    })),
    run: vi.fn(async () => ({ ok: true, action: 'unban', output: 'unbanned' })),
  },
}))

vi.mock('@/services/incident.service', () => ({
  incidentService: {
    scan: vi.fn(async () => ({})),
    kill: vi.fn(async () => ({ ok: true, output: 'killed' })),
    quarantine: vi.fn(async () => ({ ok: true, output: 'quarantined' })),
    blockIp: vi.fn(async () => ({ ok: true, output: 'iptables updated' })),
  },
}))

import { fail2banService } from '@/services/fail2ban.service'
import { forensicsService } from '@/services/forensics.service'
import { incidentService } from '@/services/incident.service'
import { ForensicsView } from '../views/ForensicsView'

describe('ForensicsView', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.spyOn(window, 'confirm').mockReturnValue(true)
  })

  it('muestra las secciones de sesiones e intentos', async () => {
    render(<ForensicsView profileId="p1" />)
    expect(await screen.findByText('Sesiones SSH')).toBeInTheDocument()
    expect(screen.getByText('Intentos SSH')).toBeInTheDocument()
    expect(await screen.findByText(/Sin sesiones/i)).toBeInTheDocument()
  })

  it('permite filtrar y ordenar intentos de autenticación SSH', async () => {
    render(<ForensicsView profileId="p1" />)

    // Cambiar a la pestaña de intentos SSH
    fireEvent.click(screen.getByText('Intentos SSH'))

    // Verificar que se cargan los 3 intentos
    expect(await screen.findByText('190.142.109.102')).toBeInTheDocument()
    expect(screen.getByText('2.57.121.25')).toBeInTheDocument()
    expect(screen.getByText('115.190.229.117')).toBeInTheDocument()

    // Filtrar solo fallidos
    const failedPill = screen.getByRole('button', { name: /Fallos/i })
    fireEvent.click(failedPill)

    expect(screen.queryByText('190.142.109.102')).not.toBeInTheDocument()
    expect(screen.getByText('2.57.121.25')).toBeInTheDocument()
    expect(screen.getByText('115.190.229.117')).toBeInTheDocument()

    // Filtrar solo éxitos
    const successPill = screen.getByRole('button', { name: /Éxitos/i })
    fireEvent.click(successPill)

    expect(screen.getByText('190.142.109.102')).toBeInTheDocument()
    expect(screen.queryByText('2.57.121.25')).not.toBeInTheDocument()

    // Filtrar bloqueadas (2.57.121.25 provisto por el mock de fail2ban)
    const blockedPill = screen.getByRole('button', { name: /Bloqueadas/i })
    fireEvent.click(blockedPill)

    expect(screen.getByText('2.57.121.25')).toBeInTheDocument()
    expect(screen.queryByText('115.190.229.117')).not.toBeInTheDocument()

    // Volver a Todos
    fireEvent.click(screen.getByRole('button', { name: /Todos/i }))
    expect(screen.getByText('190.142.109.102')).toBeInTheDocument()

    // Ordenar por USUARIO
    const userHeader = screen.getByRole('button', { name: /USUARIO/i })
    fireEvent.click(userHeader)
    expect(userHeader).toHaveClass('is-active')
  })

  it('permite desbloquear una IP bloqueada', async () => {
    render(<ForensicsView profileId="p1" />)
    fireEvent.click(screen.getByText('Intentos SSH'))

    // 2.57.121.25 inicia como bloqueada debido al reporte de fail2ban
    const unblockBtn = await screen.findByRole('button', { name: /Desbloquear/i })
    expect(unblockBtn).toBeInTheDocument()

    // Ejecutar desbloqueo
    fireEvent.click(unblockBtn)

    expect(window.confirm).toHaveBeenCalled()
    await waitFor(() => {
      expect(incidentService.blockIp).toHaveBeenCalledWith('p1', '2.57.121.25', false)
      expect(fail2banService.run).toHaveBeenCalledWith('p1', {
        action: 'unban',
        ip: '2.57.121.25',
      })
    })
  })

  it('permite bloquear una IP en un intento fallido', async () => {
    render(<ForensicsView profileId="p1" />)
    fireEvent.click(screen.getByText('Intentos SSH'))

    // 115.190.229.117 no está bloqueada, debe mostrar botón Bloquear
    const blockBtn = await screen.findByTitle('Bloquear IP 115.190.229.117')
    expect(blockBtn).toBeInTheDocument()

    fireEvent.click(blockBtn)

    expect(window.confirm).toHaveBeenCalled()
    await waitFor(() => {
      expect(incidentService.blockIp).toHaveBeenCalledWith('p1', '115.190.229.117', true)
    })
  })

  it('mantiene estados de carga independientes entre pestañas', async () => {
    let resolveSecrets!: (val: unknown) => void
    const secretsPromise = new Promise((resolve) => {
      resolveSecrets = resolve
    })
    vi.mocked(forensicsService.secrets).mockImplementationOnce(() => secretsPromise as never)

    render(<ForensicsView profileId="p1" />)
    // Esperar a que la carga inicial de sesiones termine
    expect(await screen.findByRole('button', { name: /Actualizar/i })).toBeInTheDocument()

    // Cambiar a Secretos y pulsar Escanear
    fireEvent.click(screen.getByText('Secretos'))
    const scanBtn = screen.getByRole('button', { name: /Escanear/i })
    fireEvent.click(scanBtn)

    // El botón de Secretos pasa a estar en ejecución
    expect(screen.getByRole('button', { name: /Ejecutando…/i })).toBeDisabled()

    // Cambiar a Sesiones SSH: su botón Actualizar no debe estar bloqueado ni cargando
    fireEvent.click(screen.getByText('Sesiones SSH'))
    const refreshSessionsBtn = screen.getByRole('button', { name: /Actualizar/i })
    expect(refreshSessionsBtn).not.toBeDisabled()
    expect(refreshSessionsBtn).not.toHaveTextContent('Leyendo…')

    // Resolver la promesa de secretos
    resolveSecrets([])
    await waitFor(() => {
      fireEvent.click(screen.getByText('Secretos'))
      expect(screen.getByRole('button', { name: /Escanear/i })).not.toBeDisabled()
    })
  })
})
