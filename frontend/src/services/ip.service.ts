import type { IpOwner } from '@/types'

const TIMEOUT_MS = 7000
const CACHE_MS = 6 * 60 * 60 * 1000
const cache = new Map<string, { at: number; owner: IpOwner }>()

interface IpwhoResponse {
  success?: boolean
  ip?: string
  type?: string
  country?: string
  country_code?: string
  region?: string
  city?: string
  connection?: {
    asn?: number
    org?: string
    isp?: string
    domain?: string
  }
  timezone?: {
    id?: string
  }
}

interface IpinfoResponse {
  ip?: string
  hostname?: string
  city?: string
  region?: string
  country?: string
  org?: string
}

interface RdapEntity {
  roles?: string[]
  vcardArray?: unknown[]
  entities?: RdapEntity[]
}

export interface RdapResponse {
  name?: string
  handle?: string
  startAddress?: string
  endAddress?: string
  cidr0_cidrs?: Array<{
    v4prefix?: string
    v6prefix?: string
    length?: number
  }>
  entities?: RdapEntity[]
}

export interface RdapDetails {
  network: string
  range: string
  abuse: string
}

async function getJson<T>(url: string): Promise<T | null> {
  const controller = new AbortController()
  const timer = window.setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const response = await fetch(url, {
      signal: controller.signal,
      cache: 'no-store',
      headers: { Accept: 'application/json' },
    })
    if (!response.ok) return null
    return (await response.json()) as T
  } catch {
    return null
  } finally {
    window.clearTimeout(timer)
  }
}

function vcardValue(entity: RdapEntity, key: string): string {
  const card = entity.vcardArray
  if (!Array.isArray(card) || !Array.isArray(card[1])) return ''
  for (const item of card[1]) {
    if (Array.isArray(item) && item[0] === key && typeof item[3] === 'string') {
      return item[3]
    }
  }
  return ''
}

function collectAbuse(entities: RdapEntity[], found: string[] = []): string[] {
  for (const entity of entities) {
    if (entity.roles?.includes('abuse')) {
      const email = vcardValue(entity, 'email')
      const name = vcardValue(entity, 'fn')
      if (email) found.push(email)
      else if (name) found.push(name)
    }
    if (entity.entities) collectAbuse(entity.entities, found)
  }
  return found
}

export function parseRdap(data: RdapResponse | null): RdapDetails {
  if (!data) return { network: '', range: '', abuse: '' }
  const cidr = data.cidr0_cidrs?.find((item) => item.v4prefix || item.v6prefix)
  const prefix = cidr
    ? `${cidr.v4prefix ?? cidr.v6prefix}/${cidr.length ?? ''}`
    : ''
  const range =
    prefix ||
    (data.startAddress && data.endAddress
      ? `${data.startAddress} – ${data.endAddress}`
      : '')
  const abuse = [...new Set(collectAbuse(data.entities ?? []))].join(', ')
  return {
    network: data.name || data.handle || '',
    range,
    abuse,
  }
}

export function splitOrg(value: string | undefined): {
  asn: string
  organization: string
} {
  const text = (value ?? '').trim()
  const match = /^(AS\d+)\s+(.*)$/i.exec(text)
  if (!match) return { asn: '', organization: text }
  return { asn: match[1].toUpperCase(), organization: match[2].trim() }
}

export const ipService = {
  async lookup(ip: string, force = false): Promise<IpOwner> {
    const cached = cache.get(ip)
    if (!force && cached && Date.now() - cached.at < CACHE_MS) return cached.owner
    const encoded = encodeURIComponent(ip)
    const [whois, info, rdap] = await Promise.all([
      getJson<IpwhoResponse>(`https://ipwho.is/${encoded}`),
      getJson<IpinfoResponse>(`https://ipinfo.io/${encoded}/json`),
      getJson<RdapResponse>(`https://rdap.org/ip/${encoded}`),
    ])
    const registered = parseRdap(rdap)
    const fallback = splitOrg(info?.org)
    const connection = whois?.connection ?? {}
    const organization = connection.org || fallback.organization
    const asn = connection.asn ? `AS${connection.asn}` : fallback.asn
    if (!organization && !asn && !registered.network && !whois?.country) {
      throw new Error('Sin datos públicos para esa IP')
    }
    const sources = [
      whois && whois.success !== false ? 'ipwho.is' : '',
      info?.ip ? 'ipinfo.io' : '',
      registered.network || registered.range ? 'RDAP' : '',
    ].filter(Boolean)
    const owner: IpOwner = {
      ip: whois?.ip || info?.ip || ip,
      type: whois?.type || (ip.includes(':') ? 'IPv6' : 'IPv4'),
      asn,
      organization,
      isp: connection.isp || connection.org || fallback.organization,
      domain: connection.domain || '',
      country: whois?.country || info?.country || '',
      countryCode: whois?.country_code || info?.country || '',
      region: whois?.region || info?.region || '',
      city: whois?.city || info?.city || '',
      timezone: whois?.timezone?.id || '',
      hostname: info?.hostname || '',
      network: registered.network,
      range: registered.range,
      abuse: registered.abuse,
      source: sources.join(' + ') || 'sin datos',
      fetchedAt: Date.now(),
    }
    cache.set(ip, { at: Date.now(), owner })
    return owner
  },
}
