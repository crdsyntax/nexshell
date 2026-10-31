import { afterEach, describe, expect, it, vi } from 'vitest'
import { ipService, parseRdap, splitOrg } from './ip.service'
import type { RdapResponse } from './ip.service'

const RDAP: RdapResponse = {
  name: 'AMAZON-IAD',
  handle: 'NET-13-216-0-0-1',
  startAddress: '13.216.0.0',
  endAddress: '13.223.255.255',
  cidr0_cidrs: [{ v4prefix: '13.216.0.0', length: 13 }],
  entities: [
    {
      roles: ['registrant'],
      vcardArray: ['vcard', [['fn', {}, 'text', 'Amazon Data Services Northern Virginia']]],
      entities: [
        {
          roles: ['abuse'],
          vcardArray: [
            'vcard',
            [
              ['fn', {}, 'text', 'Amazon EC2 Abuse'],
              ['email', {}, 'text', 'trustandsafety@support.aws.com'],
            ],
          ],
        },
      ],
    },
  ],
}

const IPWHO = {
  success: true,
  ip: '13.222.201.154',
  type: 'IPv4',
  country: 'United States',
  country_code: 'US',
  region: 'Virginia',
  city: 'Ashburn',
  connection: {
    asn: 14618,
    org: 'Amazon Data Services Northern Virginia',
    isp: 'Amazon.com, Inc.',
    domain: 'amazon.com',
  },
  timezone: { id: 'America/New_York' },
}

const IPINFO = {
  ip: '13.222.201.154',
  hostname: 'ec2-13-222-201-154.compute-1.amazonaws.com',
  city: 'Ashburn',
  region: 'Virginia',
  country: 'US',
  org: 'AS14618 Amazon.com, Inc.',
}

function jsonResponse(body: unknown, ok = true): Response {
  return { ok, json: async () => body } as Response
}

function mockFetch(handler: (url: string) => Response) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => handler(String(input))),
  )
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('parseRdap', () => {
  it('extrae red, rango y contacto de abuso', () => {
    expect(parseRdap(RDAP)).toEqual({
      network: 'AMAZON-IAD',
      range: '13.216.0.0/13',
      abuse: 'trustandsafety@support.aws.com',
    })
  })

  it('tolera respuestas vacías', () => {
    expect(parseRdap(null)).toEqual({ network: '', range: '', abuse: '' })
  })
})

describe('splitOrg', () => {
  it('separa ASN y organización', () => {
    expect(splitOrg('AS14618 Amazon.com, Inc.')).toEqual({
      asn: 'AS14618',
      organization: 'Amazon.com, Inc.',
    })
  })

  it('conserva el texto sin ASN', () => {
    expect(splitOrg('Amazon.com, Inc.')).toEqual({
      asn: '',
      organization: 'Amazon.com, Inc.',
    })
  })
})

describe('ipService.lookup', () => {
  it('combina ASN, WHOIS y RDAP', async () => {
    mockFetch((url) => {
      if (url.includes('ipwho.is')) return jsonResponse(IPWHO)
      if (url.includes('ipinfo.io')) return jsonResponse(IPINFO)
      return jsonResponse(RDAP)
    })

    const owner = await ipService.lookup('13.222.201.154')

    expect(owner.asn).toBe('AS14618')
    expect(owner.organization).toBe('Amazon Data Services Northern Virginia')
    expect(owner.isp).toBe('Amazon.com, Inc.')
    expect(owner.domain).toBe('amazon.com')
    expect(owner.hostname).toBe('ec2-13-222-201-154.compute-1.amazonaws.com')
    expect(owner.network).toBe('AMAZON-IAD')
    expect(owner.range).toBe('13.216.0.0/13')
    expect(owner.abuse).toBe('trustandsafety@support.aws.com')
    expect(owner.source).toContain('ipwho.is')
    expect(owner.source).toContain('RDAP')
  })

  it('reutiliza la caché y permite forzar la consulta', async () => {
    let hits = 0
    mockFetch((url) => {
      hits += 1
      if (url.includes('ipwho.is')) return jsonResponse(IPWHO)
      if (url.includes('ipinfo.io')) return jsonResponse(IPINFO)
      return jsonResponse(RDAP)
    })

    await ipService.lookup('198.51.100.7')
    const first = hits
    await ipService.lookup('198.51.100.7')
    expect(hits).toBe(first)
    await ipService.lookup('198.51.100.7', true)
    expect(hits).toBe(first * 2)
  })

  it('falla cuando ningún proveedor responde', async () => {
    mockFetch(() => jsonResponse({}, false))
    await expect(ipService.lookup('203.0.113.9')).rejects.toThrow(
      'Sin datos públicos para esa IP',
    )
  })
})
