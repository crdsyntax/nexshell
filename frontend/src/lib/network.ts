import { formatBytes } from '@/lib/format'
import type { IpOwner, ListeningPort, NetworkConnection, NetworkReport } from '@/types'

export function endpointIp(value: string): string {
  const index = value.lastIndexOf(':')
  if (index < 0) return value
  return value.slice(0, index).replace(/^\[|\]$/g, '')
}

const PRIVATE_V4 = [
  /^0\./,
  /^10\./,
  /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
]

export function isPrivateIp(value: string): boolean {
  const ip = value.replace(/^\[|\]$/g, '').toLowerCase()
  if (ip === '::1' || ip === '::') return true
  if (ip.includes(':')) {
    return ip.startsWith('fe80') || ip.startsWith('fc') || ip.startsWith('fd')
  }
  return PRIVATE_V4.some((pattern) => pattern.test(ip))
}

export function ipOwnerText(owner: IpOwner): string {
  return [
    `IP ${owner.ip}${owner.type ? ` (${owner.type})` : ''}`,
    `Organización: ${owner.organization || '—'}`,
    `ASN: ${owner.asn || '—'}`,
    `ISP: ${owner.isp || '—'}`,
    `Dominio: ${owner.domain || '—'}`,
    `País: ${owner.country || '—'}${owner.region ? ` / ${owner.region}` : ''}`,
    `Ciudad: ${owner.city || '—'}`,
    `Red: ${owner.network || '—'}`,
    `Rango: ${owner.range || '—'}`,
    `Reverse DNS: ${owner.hostname || '—'}`,
    `Abuso: ${owner.abuse || '—'}`,
    `Fuente: ${owner.source}`,
  ].join('\n')
}

export function networkMarkdown(
  report: NetworkReport,
  listening: ListeningPort[],
  connections: NetworkConnection[],
): string {
  const when = new Date(report.generatedAt * 1000).toLocaleString()
  const lines: string[] = [
    `# Network · ${report.hostname}`,
    '',
    `Generado: ${when}`,
    '',
    `## Listening sockets (${listening.length})`,
    '',
    '| Proto | Local | Port | Process | PID | Exposure |',
    '|---|---|---|---|---|---|',
    ...listening.map(
      (port) =>
        `| ${port.protocol} | ${port.ip} | ${port.port} | ${port.process || '—'} | ${port.pid ?? '—'} | ${port.public ? 'all interfaces' : 'loopback'} |`,
    ),
    '',
    `## Established connections (${connections.length})`,
    '',
    '| Proto | State | Local | Remote | Process | PID | TX | RX | RTT |',
    '|---|---|---|---|---|---|---|---|---|',
    ...connections.map(
      (c) =>
        `| ${c.protocol} | ${c.state} | ${c.local} | ${c.remote} | ${c.process || '—'} | ${c.pid ?? '—'} | ${formatBytes(c.bytesSent)} | ${formatBytes(c.bytesReceived)} | ${c.rtt || '—'} |`,
    ),
    '',
  ]
  return lines.join('\n')
}

export async function copyToClipboard(value: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(value)
  } catch (error) {
    console.debug('clipboard write failed, using fallback', error)
    const area = document.createElement('textarea')
    area.value = value
    area.style.position = 'fixed'
    area.style.opacity = '0'
    document.body.appendChild(area)
    area.select()
    document.execCommand('copy')
    document.body.removeChild(area)
  }
}
