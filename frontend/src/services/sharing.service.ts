import { open as openDialog, save as saveDialog } from '@tauri-apps/plugin-dialog'
import { ipc } from '@/lib/api'
import type {
  ConflictPolicy,
  ImportReport,
  ShareExportResult,
  ShareHeaderView,
  ShareImportOptions,
  ShareOptions,
  SharePrepareResult,
  SharePreview,
} from '@/types'

const SHARE_ERROR_MESSAGES: Record<string, string> = {
  SHARE_FORMAT: 'El archivo no tiene un formato .2share válido.',
  SHARE_VERSION: 'La versión del archivo .2share no es compatible con esta versión de 2Shell.',
  SHARE_TOO_LARGE: 'El archivo supera el tamaño máximo permitido (2 MiB).',
  SHARE_EXPIRED: 'El archivo .2share ha caducado. Solicita uno nuevo al emisor.',
  SHARE_KDF_INVALID: 'Los parámetros criptográficos KDF del archivo son inválidos.',
  SHARE_CIPHER_INVALID: 'Los datos cifrados del archivo están dañados o mal formados.',
  SHARE_BAD_PASSPHRASE: 'Frase incorrecta o archivo alterado. Verifica la frase e inténtalo de nuevo.',
  SHARE_PAYLOAD_INVALID: 'El contenido descifrado del archivo no cumple el esquema de seguridad.',
  SHARE_ENTRY_INVALID: 'El identificador criptográfico de la conexión no coincide.',
  SHARE_CONFLICT: 'Existen varios perfiles para este mismo servidor; elige Omitir o Duplicar.',
  SHARE_RATE_LIMITED: 'Demasiados intentos fallidos con este archivo. Espera unos minutos antes de reintentar.',
  SHARE_IO: 'No se pudo leer o escribir el archivo en disco.',
  SHARE_SESSION_EXPIRED: 'La sesión temporal de compartición caducó (5 min). Reinicia el proceso.',
  SHARE_CANCELLED: 'La operación de compartición fue cancelada.',
  SHARE_KEY_UNREADABLE: 'No se pudo leer el archivo de clave privada local (debe ser PEM de hasta 64 KiB).',
  SHARE_PROFILE_NOT_FOUND: 'El perfil seleccionado ya no existe.',
  SHARE_SECRETS_UNAVAILABLE: 'El secreto solicitado no está disponible en el perfil.',
}

export interface ParsedShareError {
  code: string | null
  rawMessage: string
  userMessage: string
}

export function parseShareError(error: unknown): ParsedShareError {
  const rawMessage = error instanceof Error ? error.message : String(error)
  const match = /^(SHARE_[A-Z_]+):\s*(.*)$/.exec(rawMessage)
  if (match) {
    const code = match[1]
    const detail = match[2]
    return {
      code,
      rawMessage: detail,
      userMessage: SHARE_ERROR_MESSAGES[code] ?? detail,
    }
  }
  return {
    code: null,
    rawMessage,
    userMessage: rawMessage,
  }
}

export function isCloudSyncedPath(filePath: string): boolean {
  const normalized = filePath.toLowerCase()
  return (
    normalized.includes('dropbox') ||
    normalized.includes('onedrive') ||
    normalized.includes('google drive') ||
    normalized.includes('googledrive') ||
    normalized.includes('nextcloud') ||
    normalized.includes('icloud')
  )
}

export function defaultShareFilename(profileName: string, date = new Date()): string {
  const slug =
    profileName
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9_-]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'node'
  const yyyy = String(date.getFullYear())
  const mm = String(date.getMonth() + 1).padStart(2, '0')
  const dd = String(date.getDate()).padStart(2, '0')
  return `2shell-${slug}-${yyyy}${mm}${dd}.2share`
}

export const sharingService = {
  prepare: (profileId: string, options: ShareOptions, dbPassword?: string) =>
    ipc.invoke<SharePrepareResult>('share_prepare', {
      profileId,
      options,
      dbPassword: dbPassword || null,
    }),

  exportFile: (destinationPath: string) =>
    ipc.invoke<ShareExportResult>('share_export', { destinationPath }),

  cancel: () => ipc.invoke<void>('share_cancel'),

  inspect: (path: string) => ipc.invoke<ShareHeaderView>('share_inspect', { path }),

  unlock: (path: string, passphrase: string) =>
    ipc.invoke<SharePreview>('share_unlock', { path, passphrase }),

  importBundle: (
    selection: string[],
    policy: ConflictPolicy,
    options: ShareImportOptions,
  ) => ipc.invoke<ImportReport>('share_import', { selection, policy, options }),

  discard: () => ipc.invoke<void>('share_discard'),

  pickSavePath: async (defaultName: string): Promise<string | null> => {
    const selected = await saveDialog({
      title: 'Guardar archivo .2share',
      defaultPath: defaultName,
      filters: [{ name: '2Shell Connection Share', extensions: ['2share'] }],
    })
    return typeof selected === 'string' ? selected : null
  },

  pickOpenPath: async (): Promise<string | null> => {
    const selected = await openDialog({
      multiple: false,
      directory: false,
      title: 'Seleccionar archivo .2share',
      filters: [{ name: '2Shell Connection Share', extensions: ['2share'] }],
    })
    return typeof selected === 'string' ? selected : null
  },
}
