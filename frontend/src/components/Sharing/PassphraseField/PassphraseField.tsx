import { useCallback, useEffect, useRef, useState } from 'react'
import { CheckIcon, CopyIcon, EyeIcon, EyeOffIcon } from '@/components/Icons'

interface PassphraseFieldProps {
  value: string
  readOnly?: boolean
  onChange?: (value: string) => void
  onCopied?: () => void
  placeholder?: string
  autoFocus?: boolean
  label?: string
}

const CLIPBOARD_CLEAR_MS = 60_000

export function PassphraseField({
  value,
  readOnly = false,
  onChange,
  onCopied,
  placeholder = 'XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX-XXXX',
  autoFocus = false,
  label,
}: PassphraseFieldProps) {
  const [visible, setVisible] = useState(readOnly)
  const [copied, setCopied] = useState(false)
  const clearTimerRef = useRef<number | null>(null)

  useEffect(() => {
    return () => {
      if (clearTimerRef.current !== null) {
        window.clearTimeout(clearTimerRef.current)
      }
    }
  }, [])

  const handleCopy = useCallback(async () => {
    if (!value) return
    try {
      await navigator.clipboard.writeText(value)
      setCopied(true)
      onCopied?.()
      if (clearTimerRef.current !== null) {
        window.clearTimeout(clearTimerRef.current)
      }
      const copiedSnapshot = value
      clearTimerRef.current = window.setTimeout(async () => {
        try {
          if (typeof navigator.clipboard.readText === 'function') {
            const current = await navigator.clipboard.readText()
            if (current === copiedSnapshot) {
              await navigator.clipboard.writeText('')
            }
          } else {
            await navigator.clipboard.writeText('')
          }
        } catch (err) {
          void err
        }
      }, CLIPBOARD_CLEAR_MS)
      window.setTimeout(() => setCopied(false), 2500)
    } catch (err) {
      void err
    }
  }, [onCopied, value])

  return (
    <div className="passphrase-field">
      {label && <label className="passphrase-field__label">{label}</label>}
      <div className="passphrase-field__row">
        {readOnly ? (
          <code
            className="passphrase-field__code"
            data-testid="passphrase-display"
          >
            {visible ? value : '••••-••••-••••-••••-••••-••••-••••-••••'}
          </code>
        ) : (
          <input
            type={visible ? 'text' : 'password'}
            className="passphrase-field__input"
            value={value}
            onChange={(event) => onChange?.(event.target.value)}
            placeholder={placeholder}
            autoFocus={autoFocus}
            spellCheck={false}
            autoComplete="off"
            data-testid="passphrase-input"
          />
        )}
        <button
          type="button"
          className="icon-button"
          title={visible ? 'Ocultar frase' : 'Mostrar frase'}
          onClick={() => setVisible((prev) => !prev)}
        >
          {visible ? <EyeOffIcon size={14} /> : <EyeIcon size={14} />}
        </button>
        {readOnly && (
          <button
            type="button"
            className="top-action"
            onClick={() => void handleCopy()}
            disabled={!value}
          >
            {copied ? <CheckIcon size={14} /> : <CopyIcon size={14} />}
            {copied ? 'Copiada' : 'Copiar frase'}
          </button>
        )}
      </div>
      {readOnly && (
        <p className="passphrase-field__hint">
          Al copiar la frase, el portapapeles se limpiará automáticamente a los 60 s si no ha cambiado.
        </p>
      )}
    </div>
  )
}
