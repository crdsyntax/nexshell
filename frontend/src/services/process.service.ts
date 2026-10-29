import { ipc } from '@/lib/api'
import type {
  NodeProcess,
  ProcessDetails,
  ProcessKillResult,
  ProcessLocation,
} from '@/types'

export const processService = {
  locate: (profileId: string, pid: number) =>
    ipc.invoke<ProcessLocation>('process_locate', { profileId, pid }),
  kill: (profileId: string, pid: number, signal: 'TERM' | 'INT' | 'KILL') =>
    ipc.invoke<ProcessKillResult>('process_kill', { profileId, pid, signal }),
  nodeProcesses: (profileId: string) =>
    ipc.invoke<NodeProcess[]>('node_processes', { profileId }),
  details: (profileId: string, pid: number) =>
    ipc.invoke<ProcessDetails>('process_details', { profileId, pid }),
}
