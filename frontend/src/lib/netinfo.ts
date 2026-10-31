const ENDPOINTS = [
  'https://api.ipify.org',
  'https://ifconfig.me/ip',
  'https://icanhazip.com',
]

const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/
const IPV6 = /^[0-9a-fA-F:]+$/

function looksLikeIp(value: string): boolean {
  return IPV4.test(value) || (value.includes(':') && IPV6.test(value))
}

export async function fetchPublicIp(): Promise<string> {
  for (const url of ENDPOINTS) {
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
