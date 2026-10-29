import { ipc } from '@/lib/api'
import type { SshActionResult, SshConfig, SshKey } from '@/types'

export const sshService = {
  keys: (profileId: string) => ipc.invoke<SshKey[]>('ssh_keys', { profileId }),
  config: (profileId: string) => ipc.invoke<SshConfig>('ssh_config', { profileId }),
  addKey: (profileId: string, user: string, publicKey: string) =>
    ipc.invoke<SshActionResult>('ssh_add_key', { profileId, user, publicKey }),
  removeKey: (profileId: string, user: string, publicKey: string) =>
    ipc.invoke<SshActionResult>('ssh_remove_key', { profileId, user, publicKey }),
  setKeyOnly: (profileId: string, enabled: boolean, confirmed: boolean) =>
    ipc.invoke<SshActionResult>('ssh_set_key_only', { profileId, enabled, confirmed }),
}
