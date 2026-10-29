import { ipc } from '@/lib/api'
import type { TerminalInfo } from '@/types'

export const terminalService = {
  open: (profileId: string, cols: number, rows: number) =>
    ipc.invoke<TerminalInfo>('terminal_open', { profileId, cols, rows }),
  openProcess: (profileId: string, pid: number, cols: number, rows: number) =>
    ipc.invoke<TerminalInfo>('terminal_open_process', { profileId, pid, cols, rows }),
  openDirectory: (profileId: string, directory: string, cols: number, rows: number) =>
    ipc.invoke<TerminalInfo>('terminal_open_directory', {
      profileId,
      directory,
      cols,
      rows,
    }),
  write: (sessionId: string, data: string) =>
    ipc.invoke<void>('terminal_write', { sessionId, data }),
  resize: (sessionId: string, cols: number, rows: number) =>
    ipc.invoke<void>('terminal_resize', { sessionId, cols, rows }),
  close: (sessionId: string) => ipc.invoke<void>('terminal_close', { sessionId }),
  list: () => ipc.invoke<TerminalInfo[]>('terminal_list'),
}
