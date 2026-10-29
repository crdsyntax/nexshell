import { ipc } from '@/lib/api'
import type { ExecutionLog, LogQuery } from '@/types'

export const auditService = {
  list: (query: LogQuery = {}) =>
    ipc.invoke<ExecutionLog[]>('list_execution_logs', {
      profileId: query.profileId,
      category: query.category,
      status: query.status,
      search: query.search,
      limit: query.limit ?? 250,
      offset: query.offset ?? 0,
    }),
  clear: (profileId?: string) =>
    ipc.invoke<number>('clear_execution_logs', { profileId }),
  dbPath: () => ipc.invoke<string>('audit_db_path'),
}
