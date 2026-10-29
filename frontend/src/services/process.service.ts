import { ipc } from '@/lib/api'
import type { NodeProcess, ProcessKillResult, ProcessLocation } from '@/types'

export const processService = {
  locate: (profileId: string, pid: number) =>
    ipc.invoke<ProcessLocation>('process_locate', { profileId, pid }),
  kill: (profileId: string, pid: number, signal: 'TERM' | 'INT' | 'KILL') =>
    ipc.invoke<ProcessKillResult>('process_kill', { profileId, pid, signal }),
  nodeProcesses: (profileId: string) =>
    ipc.invoke<NodeProcess[]>('node_processes', { profileId }),
}
