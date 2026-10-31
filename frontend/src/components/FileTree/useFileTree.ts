import { useCallback, useEffect, useMemo, useState } from 'react'
import { useAppStore } from '@/store/useAppStore'
import { fsService } from '@/services/fs.service'
import { openDirectoryTerminal } from '@/lib/actions'
import { isEditable, joinPath, parentOf } from '@/lib/fileTree'
import type { FileProperties, FsEntry } from '@/types'

export function useFileTree(profileId: string, tabId: string) {
  const cwd = useAppStore((state) => state.terminalCwd[tabId])
  const profiles = useAppStore((state) => state.profiles)
  const pushToast = useAppStore((state) => state.pushToast)
  const profile = profiles.find((item) => item.id === profileId) ?? null

  const root = cwd || '/'
  const [nodes, setNodes] = useState<Record<string, FsEntry[]>>({})
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const [loading, setLoading] = useState<Set<string>>(new Set())
  const [selected, setSelected] = useState<FsEntry | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [editorTarget, setEditorTarget] = useState<FsEntry | null>(null)
  const [showHidden, setShowHidden] = useState(false)
  const [propertiesTarget, setPropertiesTarget] = useState<FsEntry | null>(null)
  const [properties, setProperties] = useState<FileProperties | null>(null)
  const [propertiesLoading, setPropertiesLoading] = useState(false)
  const [propertiesError, setPropertiesError] = useState<string | null>(null)

  const load = useCallback(
    async (path: string) => {
      setLoading((current) => new Set(current).add(path))
      try {
        const listing = await fsService.list(profileId, path)
        setNodes((current) => ({ ...current, [path]: listing.entries }))
        setError(null)
        return listing.entries
      } catch (err) {
        setError(String(err))
        return []
      } finally {
        setLoading((current) => {
          const next = new Set(current)
          next.delete(path)
          return next
        })
      }
    },
    [profileId],
  )

  useEffect(() => {
    setNodes({})
    setSelected(null)
    setExpanded(new Set([root]))
    void load(root)
  }, [root, load])

  const toggle = async (entry: FsEntry) => {
    const isOpen = expanded.has(entry.path)
    setExpanded((current) => {
      const next = new Set(current)
      if (isOpen) next.delete(entry.path)
      else next.add(entry.path)
      return next
    })
    if (!isOpen && !nodes[entry.path]) {
      await load(entry.path)
    }
  }

  const reloadAll = async () => {
    const paths = new Set<string>([root, ...expanded])
    for (const path of paths) {
      if (path.startsWith(root) || root.startsWith(path)) {
        await load(path)
      }
    }
  }

  const targetDir = useMemo(() => {
    if (!selected) return root
    return selected.kind === 'dir' ? selected.path : parentOf(selected.path)
  }, [selected, root])

  const createEntry = async (directory: boolean) => {
    const label = directory ? 'Nueva carpeta' : 'Nuevo archivo'
    const name = window.prompt(`${label} en ${targetDir}`)
    if (!name?.trim()) return
    const path = joinPath(targetDir, name.trim())
    setBusy(true)
    try {
      await fsService.create(profileId, path, directory)
      pushToast('success', `${directory ? 'Carpeta' : 'Archivo'} creado: ${path}`)
      await reloadAll()
    } catch (err) {
      pushToast('error', String(err))
    } finally {
      setBusy(false)
    }
  }

  const renameSelected = async () => {
    if (!selected) return
    const name = window.prompt('Nuevo nombre', selected.name)
    if (!name?.trim() || name.trim() === selected.name) return
    const target = joinPath(parentOf(selected.path), name.trim())
    setBusy(true)
    try {
      await fsService.rename(profileId, selected.path, target)
      pushToast('success', `Renombrado a ${target}`)
      setSelected(null)
      await reloadAll()
    } catch (err) {
      pushToast('error', String(err))
    } finally {
      setBusy(false)
    }
  }

  const deleteSelected = async () => {
    if (!selected) return
    if (!window.confirm(`¿Eliminar ${selected.path}? Esta acción no se puede deshacer.`)) {
      return
    }
    setBusy(true)
    try {
      await fsService.remove(profileId, selected.path)
      pushToast('success', `Eliminado ${selected.path}`)
      setSelected(null)
      await reloadAll()
    } catch (err) {
      pushToast('error', String(err))
    } finally {
      setBusy(false)
    }
  }

  const openProperties = async (entry: FsEntry) => {
    setPropertiesTarget(entry)
    setProperties(null)
    setPropertiesError(null)
    setPropertiesLoading(true)
    try {
      setProperties(await fsService.properties(profileId, entry.path))
    } catch (err) {
      setPropertiesError(String(err))
    } finally {
      setPropertiesLoading(false)
    }
  }

  const openEntry = (entry: FsEntry) => {
    if (entry.kind === 'dir') return
    if (isEditable(entry)) setEditorTarget(entry)
    else pushToast('error', `${entry.name} parece binario; ábrelo por terminal.`)
  }

  const collapseAll = () => setExpanded(new Set([root]))

  const closeProperties = () => {
    setPropertiesTarget(null)
    setProperties(null)
  }

  const openTerminal = () => {
    if (!profile) return
    openDirectoryTerminal(profile, targetDir)
  }

  return {
    cwd,
    profile,
    root,
    nodes,
    expanded,
    loading,
    selected,
    setSelected,
    error,
    busy,
    editorTarget,
    setEditorTarget,
    showHidden,
    setShowHidden,
    propertiesTarget,
    setPropertiesTarget,
    properties,
    propertiesLoading,
    propertiesError,
    targetDir,
    toggle,
    reloadAll,
    createEntry,
    renameSelected,
    deleteSelected,
    openProperties,
    closeProperties,
    openEntry,
    collapseAll,
    openTerminal,
  }
}
