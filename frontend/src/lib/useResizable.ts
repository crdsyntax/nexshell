import { useCallback, useEffect, useRef, useState } from 'react'

interface Size {
  width: number
  height: number
}

interface Options {
  initial: Size
  min?: Size
  storageKey?: string
}

const DEFAULT_MIN: Size = { width: 440, height: 280 }

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}

function readStored(key: string | undefined): Size | null {
  if (!key) return null
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<Size>
    if (typeof parsed.width !== 'number' || typeof parsed.height !== 'number') return null
    return { width: parsed.width, height: parsed.height }
  } catch {
    return null
  }
}

export function useResizable({ initial, min = DEFAULT_MIN, storageKey }: Options) {
  const [size, setSize] = useState<Size>(() => readStored(storageKey) ?? initial)
  const latest = useRef(size)
  latest.current = size

  useEffect(() => {
    if (!storageKey) return
    try {
      window.localStorage.setItem(storageKey, JSON.stringify(size))
    } catch {
    }
  }, [size, storageKey])

  const start = useCallback(
    (event: React.PointerEvent<HTMLElement>) => {
      event.preventDefault()
      const originX = event.clientX
      const originY = event.clientY
      const startSize = latest.current

      const move = (moveEvent: PointerEvent) => {
        const maxWidth = window.innerWidth * 0.96
        const maxHeight = window.innerHeight * 0.92
        setSize({
          width: clamp(startSize.width + (moveEvent.clientX - originX), min.width, maxWidth),
          height: clamp(startSize.height + (moveEvent.clientY - originY), min.height, maxHeight),
        })
      }
      const stop = () => {
        window.removeEventListener('pointermove', move)
        window.removeEventListener('pointerup', stop)
        window.removeEventListener('pointercancel', stop)
      }
      window.addEventListener('pointermove', move)
      window.addEventListener('pointerup', stop)
      window.addEventListener('pointercancel', stop)
    },
    [min.height, min.width],
  )

  const style = {
    width: `${Math.round(size.width)}px`,
    height: `${Math.round(size.height)}px`,
    maxWidth: '96vw',
    maxHeight: '92vh',
  }

  return { style, start, size }
}
