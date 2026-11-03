import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { DbInfo } from '@/types'

vi.mock('@/services/database.service', () => ({
  databaseService: {
    info: vi.fn(),
    users: vi.fn(),
    grants: vi.fn(),
    changePassword: vi.fn(),
    testLogin: vi.fn(),
  },
}))

import { databaseService } from '@/services/database.service'
import { DatabasePanel } from '../DatabasePanel'

const INFO: DbInfo = {
  installed: true,
  client: '/usr/bin/mariadb',
  version: '10.11.6-MariaDB',
  hostname: 'vps-1',
  port: 3306,
  socket: '/run/mysqld/mysqld.sock',
  serviceState: 'active',
  canQuery: true,
  error: null,
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(databaseService.info).mockResolvedValue(INFO)
  vi.mocked(databaseService.users).mockResolvedValue([
    { user: 'app_user', host: 'localhost', plugin: 'mysql_native_password', system: false },
  ])
})

describe('DatabasePanel', () => {
  it('no consulta la base de datos hasta introducir la contraseña', () => {
    render(<DatabasePanel profileId="p1" />)

    expect(screen.getByText('Conectar a MariaDB / MySQL')).toBeInTheDocument()
    expect(databaseService.info).not.toHaveBeenCalled()
    expect(databaseService.users).not.toHaveBeenCalled()
  })

  it('conecta con las credenciales introducidas', async () => {
    render(<DatabasePanel profileId="p1" />)

    fireEvent.change(screen.getByLabelText('Contraseña'), {
      target: { value: 's3cret-pass' },
    })
    fireEvent.click(screen.getByRole('button', { name: /Conectar y detectar/i }))

    expect(await screen.findByText('app_user')).toBeInTheDocument()
    expect(databaseService.info).toHaveBeenCalledWith('p1', {
      user: 'root',
      password: 's3cret-pass',
      host: 'localhost',
      port: 3306,
    })
    expect(databaseService.users).toHaveBeenCalledWith('p1', {
      user: 'root',
      password: 's3cret-pass',
      host: 'localhost',
      port: 3306,
    })
  })

  it('muestra el error de autenticación sin listar usuarios', async () => {
    vi.mocked(databaseService.info).mockResolvedValue({
      ...INFO,
      canQuery: false,
      error: 'ERROR 1045 (28000): Access denied',
    })
    render(<DatabasePanel profileId="p1" />)

    fireEvent.change(screen.getByLabelText('Contraseña'), {
      target: { value: 'wrong-pass' },
    })
    fireEvent.click(screen.getByRole('button', { name: /Conectar y detectar/i }))

    expect(await screen.findByText(/Access denied/)).toBeInTheDocument()
    await waitFor(() => expect(databaseService.users).not.toHaveBeenCalled())
    expect(screen.getByText('Conectar a MariaDB / MySQL')).toBeInTheDocument()
  })
})
