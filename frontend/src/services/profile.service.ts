import { ipc } from '@/lib/api'
import type {
  ExecOutput,
  KeyProbe,
  PoolStats,
  Profile,
  ProfileInput,
  ServerInfo,
  TestResult,
} from '@/types'

export const profileService = {
  localIp: () => ipc.invoke<string>('local_ip'),
  list: () => ipc.invoke<Profile[]>('list_profiles'),
  save: (profile: ProfileInput) => ipc.invoke<Profile>('save_profile', { profile }),
  remove: (id: string) => ipc.invoke<void>('delete_profile', { id }),
  test: (profile: ProfileInput) => ipc.invoke<TestResult>('test_profile', { profile }),
  probeKey: (path: string) => ipc.invoke<KeyProbe>('probe_ssh_key', { path }),
  connect: (id: string) => ipc.invoke<PoolStats>('connect_profile', { id }),
  disconnect: (id: string) => ipc.invoke<void>('disconnect_profile', { id }),
  detectServer: (id: string) => ipc.invoke<ServerInfo>('detect_server', { id }),
  poolStats: (id: string) => ipc.invoke<PoolStats>('pool_stats', { id }),
  exec: (id: string, command: string) =>
    ipc.invoke<ExecOutput>('remote_exec', { id, command }),
}
