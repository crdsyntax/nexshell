import type { FsEntry } from '@/types'

export function joinPath(parent: string, name: string): string {
  return parent.endsWith('/') ? `${parent}${name}` : `${parent}/${name}`
}

const BINARY_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'tiff', 'svgz',
  'pdf', 'zip', 'gz', 'tgz', 'bz2', 'xz', '7z', 'rar', 'tar',
  'so', 'o', 'a', 'bin', 'exe', 'dll', 'class', 'jar', 'wasm',
  'mp3', 'mp4', 'mov', 'avi', 'mkv', 'wav', 'ogg', 'webm',
  'woff', 'woff2', 'ttf', 'otf', 'eot',
  'sqlite', 'sqlite3', 'db', 'pyc', 'pkl', 'img', 'iso',
])

export function isEditable(entry: FsEntry): boolean {
  if (entry.kind !== 'file') return false
  if (entry.sizeBytes > 5 * 1024 * 1024) return false
  const name = entry.name.toLowerCase()
  if (name === 'dockerfile' || name === 'makefile' || name === 'procfile') return true
  const dot = name.lastIndexOf('.')
  if (dot <= 0) return true
  return !BINARY_EXTENSIONS.has(name.slice(dot + 1))
}

export function parentOf(path: string): string {
  if (path === '/') return '/'
  const trimmed = path.replace(/\/+$/, '')
  const index = trimmed.lastIndexOf('/')
  return index <= 0 ? '/' : trimmed.slice(0, index)
}
