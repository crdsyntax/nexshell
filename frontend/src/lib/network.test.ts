import { describe, expect, it } from 'vitest'
import { endpointIp, ipOwnerText, isPrivateIp } from './network'
import type { IpOwner } from '@/types'

describe('endpointIp', () => {
  it('separa la IP del puerto', () => {
    expect(endpointIp('13.222.201.154:16556')).toBe('13.222.201.154')
    expect(endpointIp('[2001:db8::1]:443')).toBe('2001:db8::1')
  })
})

describe('isPrivateIp', () => {
  it('detecta rangos privados y loopback', () => {
    expect(isPrivateIp('10.0.0.4')).toBe(true)
    expect(isPrivateIp('172.20.10.2')).toBe(true)
    expect(isPrivateIp('192.168.1.10')).toBe(true)
    expect(isPrivateIp('127.0.0.1')).toBe(true)
    expect(isPrivateIp('::1')).toBe(true)
    expect(isPrivateIp('fd00::1')).toBe(true)
  })

  it('acepta direcciones públicas', () => {
    expect(isPrivateIp('13.222.201.154')).toBe(false)
    expect(isPrivateIp('8.8.8.8')).toBe(false)
    expect(isPrivateIp('2606:4700::1111')).toBe(false)
  })
})

describe('ipOwnerText', () => {
  it('genera un resumen copiable', () => {
    const owner: IpOwner = {
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
    const text = ipOwnerText(owner)
    expect(text).toContain('IP 13.222.201.154 (IPv4)')
    expect(text).toContain('Organización: Amazon Data Services Northern Virginia')
    expect(text).toContain('ASN: AS14618')
    expect(text).toContain('Rango: 13.216.0.0/13')
  })
})
