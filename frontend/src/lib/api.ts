import { invoke } from '@tauri-apps/api/core'

function extractError(error: unknown): string {
  if (typeof error === 'string') return error
  if (error instanceof Error) return error.message
  if (error && typeof error === 'object') {
    const keys = Object.keys(error)
    if (keys.length === 1) {
      const content = (error as Record<string, unknown>)[keys[0]]
      if (typeof content === 'string') return content
      return JSON.stringify(content)
    }
    if ('message' in error) {
      const message = (error as { message: unknown }).message
      if (typeof message === 'string') return message
    }
    try {
      return JSON.stringify(error)
    } catch {
      return 'Unknown error'
    }
  }
  return 'Unknown error'
}

export const ipc = {
  async invoke<T>(command: string, args: Record<string, unknown> = {}): Promise<T> {
    try {
      return await invoke<T>(command, args)
    } catch (error) {
      const message = extractError(error)
      console.error(`[2shell] ${command} failed: ${message}`)
      throw new Error(message)
    }
  },
}
