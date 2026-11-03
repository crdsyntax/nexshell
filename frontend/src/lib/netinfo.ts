const ENDPOINTS: Record<'auto' | 'v4' | 'v6', string[]> = {
  auto: [
    'https://api64.ipify.org',
    'https://api.ipify.org',
    'https://ifconfig.me/ip',
    'https://icanhazip.com',
  ],
  v4: ['https://api.ipify.org', 'https://ifconfig.me/ip', 'https://icanhazip.com'],
  v6: ['https://api6.ipify.org', 'https://ipv6.icanhazip.com'],
}

const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/
const IPV6 = /^[0-9a-fA-F:]+$/

function looksLikeIp(value: string): boolean {
  return IPV4.test(value) || (value.includes(':') && IPV6.test(value))
}

export function ipFamily(value: string): 'ipv4' | 'ipv6' | null {
  const base = value.trim().split('/')[0]
  if (IPV4.test(base)) return 'ipv4'
  if (base.includes(':') && IPV6.test(base)) return 'ipv6'
  return null
}

export async function fetchPublicIp(family: 'auto' | 'v4' | 'v6' = 'auto'): Promise<string> {
  for (const url of ENDPOINTS[family]) {
    const controller = new AbortController()
    const timer = window.setTimeout(() => controller.abort(), 4000)
    try {
      const response = await fetch(url, { signal: controller.signal, cache: 'no-store' })
      window.clearTimeout(timer)
      if (!response.ok) continue
      const text = (await response.text()).trim()
      if (looksLikeIp(text)) return text
    } catch {
      window.clearTimeout(timer)
    }
  }
  throw new Error('no se pudo obtener la IP pública')
}
