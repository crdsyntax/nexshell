import { ipc } from '@/lib/api'
import type { DirListing } from '@/types'

export const fsService = {
  list: (profileId: string, path: string) =>
    ipc.invoke<DirListing>('fs_list', { profileId, path }),
  editor: (profileId: string) => ipc.invoke<string>('fs_editor', { profileId }),
  create: (profileId: string, path: string, directory: boolean) =>
    ipc.invoke<string>('fs_create', { profileId, path, directory }),
  rename: (profileId: string, from: string, to: string) =>
    ipc.invoke<string>('fs_rename', { profileId, from, to }),
  remove: (profileId: string, path: string) =>
    ipc.invoke<string>('fs_delete', { profileId, path }),
}
