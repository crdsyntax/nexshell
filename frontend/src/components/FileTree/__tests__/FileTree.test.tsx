import { fireEvent, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useAppStore } from '@/store/useAppStore'
import type { DirListing, FsEntry } from '@/types'

vi.mock('@/services/fs.service', () => ({
  fsService: {
    list: vi.fn(),
    editor: vi.fn(),
    properties: vi.fn(),
    create: vi.fn(),
    rename: vi.fn(),
    remove: vi.fn(),
  },
}))

import { fsService } from '@/services/fs.service'
import { FileTree } from '../FileTree'

const ENTRIES: FsEntry[] = [
  {
    name: 'src',
    path: '/var/www/app/src',
    kind: 'dir',
    sizeBytes: 4096,
    sizeHuman: '4.0 KB',
    mode: '755',
    modified: '2026-11-02 10:00:00',
    empty: false,
    hidden: false,
    symlink: false,
  },
  {
    name: 'server.ts',
    path: '/var/www/app/server.ts',
    kind: 'file',
    sizeBytes: 1200,
    sizeHuman: '1.2 KB',
    mode: '644',
    modified: '2026-11-02 10:00:00',
    empty: false,
    hidden: false,
    symlink: false,
  },
  {
    name: 'package.json',
    path: '/var/www/app/package.json',
    kind: 'file',
    sizeBytes: 850,
    sizeHuman: '850 B',
    mode: '644',
    modified: '2026-11-02 10:00:00',
    empty: false,
    hidden: false,
    symlink: false,
  },
  {
    name: 'error.log',
    path: '/var/www/app/error.log',
    kind: 'file',
    sizeBytes: 4200,
    sizeHuman: '4.1 KB',
    mode: '644',
    modified: '2026-11-02 10:00:00',
    empty: false,
    hidden: false,
    symlink: false,
  },
]

const LISTING: DirListing = {
  path: '/var/www/app',
  parent: '/var/www',
  entries: ENTRIES,
}

beforeEach(() => {
  vi.clearAllMocks()
  useAppStore.setState({
    terminalCwd: { t1: '/var/www/app' },
    profiles: [],
  })
  vi.mocked(fsService.list).mockResolvedValue(LISTING)
})

describe('FileTree', () => {
  it('filtra archivos por nombre y por extensión', async () => {
    render(<FileTree profileId="p1" tabId="t1" onClose={vi.fn()} />)

    expect(await screen.findByText('server.ts')).toBeInTheDocument()
    expect(screen.getByText('package.json')).toBeInTheDocument()
    expect(screen.getByText('error.log')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Buscar por nombre'), {
      target: { value: 'server' },
    })
    expect(screen.getByText('server.ts')).toBeInTheDocument()
    expect(screen.queryByText('package.json')).toBeNull()
    expect(screen.queryByText('error.log')).toBeNull()

    fireEvent.click(screen.getByTitle('Limpiar búsqueda'))
    expect(screen.getByText('package.json')).toBeInTheDocument()

    fireEvent.change(screen.getByLabelText('Filtrar por extensión'), {
      target: { value: '.json, log' },
    })
    expect(screen.getByText('package.json')).toBeInTheDocument()
    expect(screen.getByText('error.log')).toBeInTheDocument()
    expect(screen.queryByText('server.ts')).toBeNull()
    expect(screen.queryByText('src')).toBeNull()
  })
})
