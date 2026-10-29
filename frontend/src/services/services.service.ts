import { ipc } from '@/lib/api'
import type {
  ConfigContent,
  ConfigEntry,
  ServiceActionResult,
  ServiceStatus,
  WebServiceInfo,
} from '@/types'

export const serviceManager = {
  detect: (id: string) => ipc.invoke<WebServiceInfo[]>('service_detect', { id }),
  status: (id: string, service: string) =>
    ipc.invoke<ServiceStatus>('service_status', { id, service }),
  action: (id: string, service: string, action: string) =>
    ipc.invoke<ServiceActionResult>('service_action', { id, service, action }),
  configList: (id: string, service: string) =>
    ipc.invoke<ConfigEntry[]>('service_config_list', { id, service }),
  configRead: (id: string, service: string, path: string) =>
    ipc.invoke<ConfigContent>('service_config_read', { id, service, path }),
  configWrite: (id: string, service: string, path: string, content: string) =>
    ipc.invoke<ServiceActionResult>('service_config_write', {
      id,
      service,
      path,
      content,
    }),
  logs: (id: string, service: string, lines = 200) =>
    ipc.invoke<string>('service_logs', { id, service, lines }),
}
