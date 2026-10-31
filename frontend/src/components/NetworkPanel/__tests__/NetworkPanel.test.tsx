import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  ConnectionInspection,
  IpOwner,
  NetworkConnection,
  NetworkReport,
  ProcessDetails,
} from '@/types'

vi.mock('@/services/network.service', () => ({
  networkService: { scan: vi.fn(), inspect: vi.fn() },
}))

vi.mock('@/services/ip.service', () => ({
  ipService: { lookup: vi.fn() },
}))

vi.mock('@/services/process.service', () => ({
  processService: { details: vi.fn() },
}))

import { networkService } from '@/services/network.service'
import { ipService } from '@/services/ip.service'
import { processService } from '@/services/process.service'
import { NetworkPanel } from '../NetworkPanel'

const CONNECTION: NetworkConnection = {
  protocol: 'tcp',
  state: 'ESTABLISHED',
  local: '165.232.158.163:36280',
  remote: '13.222.201.154:16556',
  process: 'node /var/www/f',
  pid: 3013683,
  bytesSent: 307,
  bytesReceived: 4731,
  rtt: '72.513/6.635',
}

const PROCESS: ProcessDetails = {
  pid: 3013683,
  user: 'www-data',
  state: 'S',
  cpu: 1.2,
  mem: 0.8,
  rssKb: 52345,
  threads: 11,
  started: 'Sat Oct 31 12:00:00 2026',
  exe: '/usr/bin/node',
  cwd: '/var/www/fullstack-app',
  command: 'node /var/www/fullstack-app/server.js --port 3000',
  openFiles: 42,
}

const INSPECTION: ConnectionInspection = {
  pid: 3013683,
  remote: '13.222.201.154:16556',
  generatedAt: 0,
  sections: [
    { title: 'Socket TCP', lines: ['tcp ESTAB 0 0 165.232.158.163:36280 13.222.201.154:16556 ino:12345'] },
    {
      title: 'Referencias en el proyecto',
      lines: ['[ip] /var/www/felizviajeapi/src/config.ts:12'],
    },
  ],
}

const OWNER: IpOwner = {
  ip: '13.222.201.154',
  type: 'IPv4',
  asn: 'AS14618',
  organization: 'Amazon Data Services Northern Virginia',
  isp: 'Amazon.com, Inc.',
  domain: 'amazon.com',
  country: 'United States',
  countryCode: 'US',
  region: 'Virginia',
  city: 'Ashburn',
  timezone: 'America/New_York',
  hostname: 'ec2-13-222-201-154.compute-1.amazonaws.com',
  network: 'AMAZON-IAD',
  range: '13.216.0.0/13',
  abuse: 'trustandsafety@support.aws.com',
  source: 'ipwho.is + RDAP',
  fetchedAt: 0,
}

function report(connection: NetworkConnection): NetworkReport {
  return {
    hostname: 'vps-1',
    generatedAt: 0,
    listening: [],
    connections: [connection],
    listeningSummary: [],
    stats: [],
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(ipService.lookup).mockResolvedValue(OWNER)
  vi.mocked(processService.details).mockResolvedValue(PROCESS)
  vi.mocked(networkService.inspect).mockResolvedValue(INSPECTION)
})

describe('NetworkPanel', () => {
  it('muestra el titular de la IP al abrir el tráfico', async () => {
    vi.mocked(networkService.scan).mockResolvedValue(report(CONNECTION))
    render(<NetworkPanel profileId="p1" />)

    fireEvent.click(await screen.findByText('13.222.201.154:16556'))
    fireEvent.click(await screen.findByRole('tab', { name: /Titular IP/i }))

    expect(await screen.findByText('¿De quién es esta IP?')).toBeInTheDocument()
    expect(await screen.findByText('Amazon Data Services Northern Virginia')).toBeInTheDocument()
    expect(screen.getAllByText('AS14618').length).toBeGreaterThan(0)
    expect(screen.getByText('13.216.0.0/13')).toBeInTheDocument()
    expect(ipService.lookup).toHaveBeenCalledWith('13.222.201.154', false)
  })

  it('resuelve el comando y el cwd reales del PID', async () => {
    vi.mocked(networkService.scan).mockResolvedValue(report(CONNECTION))
    render(<NetworkPanel profileId="p1" />)

    fireEvent.click(await screen.findByText('13.222.201.154:16556'))
    fireEvent.click(await screen.findByRole('tab', { name: /^Proceso/i }))

    expect(
      await screen.findByText('node /var/www/fullstack-app/server.js --port 3000'),
    ).toBeInTheDocument()
    expect(screen.getByText('/var/www/fullstack-app')).toBeInTheDocument()
    expect(screen.getByText('/usr/bin/node')).toBeInTheDocument()
    expect(processService.details).toHaveBeenCalledWith('p1', 3013683)
  })

  it('analiza sockets, FDs y referencias del proyecto', async () => {
    vi.mocked(networkService.scan).mockResolvedValue(report(CONNECTION))
    render(<NetworkPanel profileId="p1" />)

    fireEvent.click(await screen.findByText('13.222.201.154:16556'))
    fireEvent.click(await screen.findByRole('tab', { name: /Diagnóstico/i }))

    expect(await screen.findByText('Diagnóstico de la conexión')).toBeInTheDocument()
    expect(screen.getByText(/ino:12345/)).toBeInTheDocument()
    expect(
      screen.getByText('[ip] /var/www/felizviajeapi/src/config.ts:12'),
    ).toBeInTheDocument()
    expect(networkService.inspect).toHaveBeenCalledWith(
      'p1',
      3013683,
      '13.222.201.154:16556',
      false,
    )
  })

  it('no consulta direcciones privadas', async () => {
    const local: NetworkConnection = {
      ...CONNECTION,
      local: '127.0.0.1:38120',
      remote: '127.0.0.1:5432',
      process: 'postgres',
    }
    vi.mocked(networkService.scan).mockResolvedValue(report(local))
    render(<NetworkPanel profileId="p1" />)

    fireEvent.click(await screen.findByText('127.0.0.1:5432'))
    fireEvent.click(await screen.findByRole('tab', { name: /Titular IP/i }))

    expect(await screen.findByText(/Dirección privada o loopback/)).toBeInTheDocument()
    await waitFor(() => expect(ipService.lookup).not.toHaveBeenCalled())
  })
})
