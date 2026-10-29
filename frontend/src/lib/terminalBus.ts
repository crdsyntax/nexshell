type TerminalWriter = (data: Uint8Array) => void

const writers = new Map<string, TerminalWriter>()
const pending = new Map<string, Uint8Array[]>()
const pendingBytes = new Map<string, number>()
const MAX_PENDING_BYTES = 1024 * 1024

export function decodeBase64(input: string): Uint8Array {
  const binary = atob(input)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i)
  }
  return bytes
}

export function attachTerminal(sessionId: string, writer: TerminalWriter) {
  writers.set(sessionId, writer)
  const chunks = pending.get(sessionId)
  if (chunks) {
    for (const chunk of chunks) writer(chunk)
    pending.delete(sessionId)
    pendingBytes.delete(sessionId)
  }
}

export function detachTerminal(sessionId: string) {
  writers.delete(sessionId)
}

export function pushTerminalData(sessionId: string, base64: string) {
  const bytes = decodeBase64(base64)
  const writer = writers.get(sessionId)
  if (writer) {
    writer(bytes)
    return
  }

  const buffered = pendingBytes.get(sessionId) ?? 0
  if (buffered + bytes.byteLength > MAX_PENDING_BYTES) return
  const chunks = pending.get(sessionId) ?? []
  chunks.push(bytes)
  pending.set(sessionId, chunks)
  pendingBytes.set(sessionId, buffered + bytes.byteLength)
}

export function clearTerminalBuffer(sessionId: string) {
  pending.delete(sessionId)
  pendingBytes.delete(sessionId)
}
