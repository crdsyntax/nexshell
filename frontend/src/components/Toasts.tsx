import { useAppStore } from '@/store/useAppStore'
import { AlertIcon, CheckIcon, InfoIcon } from '@/components/Icons'

export function Toasts() {
  const toasts = useAppStore((state) => state.toasts)
  const dismiss = useAppStore((state) => state.dismissToast)

  return (
    <div className="toast-stack">
      {toasts.map((toast) => (
        <button
          key={toast.id}
          className={`toast toast--${toast.kind}`}
          onClick={() => dismiss(toast.id)}
        >
          <span className="toast__icon">
            {toast.kind === 'success' && <CheckIcon size={14} />}
            {toast.kind === 'error' && <AlertIcon size={14} />}
            {toast.kind === 'info' && <InfoIcon size={14} />}
          </span>
          <span>{toast.text}</span>
        </button>
      ))}
    </div>
  )
}
