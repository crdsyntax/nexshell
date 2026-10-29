import { ipc } from '@/lib/api'
import type { FileDeleteResult, FileProperties, LargeFile } from '@/types'

export const filesystemService = {
  largeFiles: (profileId: string) =>
    ipc.invoke<LargeFile[]>('disk_large_files', { profileId }),
  properties: (profileId: string, path: string) =>
    ipc.invoke<FileProperties>('file_properties', { profileId, path }),
  delete: (profileId: string, path: string) =>
    ipc.invoke<FileDeleteResult>('file_delete', { profileId, path }),
}
