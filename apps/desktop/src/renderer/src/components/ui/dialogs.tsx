import * as Dialog from '@radix-ui/react-dialog'
import { useEffect, useState, type ReactElement, type ReactNode } from 'react'

export function Modal(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description?: ReactNode
  children?: ReactNode
}): ReactElement {
  return (
    <Dialog.Root open={props.open} onOpenChange={props.onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="overlay" />
        <Dialog.Content className="dialog" aria-describedby={props.description ? undefined : undefined}>
          <Dialog.Title asChild>
            <h2>{props.title}</h2>
          </Dialog.Title>
          {props.description ? (
            <Dialog.Description className="muted text-[13px]">{props.description}</Dialog.Description>
          ) : (
            <Dialog.Description className="sr-only">{props.title}</Dialog.Description>
          )}
          {props.children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  )
}

export function ConfirmDialog(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  description: ReactNode
  confirmLabel: string
  danger?: boolean
  onConfirm: () => void | Promise<void>
}): ReactElement {
  const [busy, setBusy] = useState(false)
  return (
    <Modal open={props.open} onOpenChange={props.onOpenChange} title={props.title} description={props.description}>
      <div className="flex justify-end gap-2">
        <button type="button" className="btn sm" onClick={() => props.onOpenChange(false)}>
          Cancel
        </button>
        <button
          type="button"
          className={props.danger ? 'btn sm danger' : 'btn sm primary'}
          disabled={busy}
          onClick={async () => {
            setBusy(true)
            try {
              await props.onConfirm()
            } finally {
              setBusy(false)
              props.onOpenChange(false)
            }
          }}
        >
          {props.confirmLabel}
        </button>
      </div>
    </Modal>
  )
}

export function PromptDialog(props: {
  open: boolean
  onOpenChange: (open: boolean) => void
  title: string
  label: string
  initial?: string
  placeholder?: string
  confirmLabel: string
  multiline?: boolean
  onConfirm: (value: string) => void | Promise<void>
}): ReactElement {
  const [value, setValue] = useState(props.initial ?? '')
  useEffect(() => {
    if (props.open) setValue(props.initial ?? '')
  }, [props.open, props.initial])
  const submit = async (): Promise<void> => {
    if (!value.trim()) return
    await props.onConfirm(value)
    props.onOpenChange(false)
  }
  return (
    <Modal open={props.open} onOpenChange={props.onOpenChange} title={props.title}>
      <form
        className="flex flex-col gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          void submit()
        }}
      >
        <label className="f">
          {props.label}
          {props.multiline ? (
            <textarea
              className="input"
              value={value}
              placeholder={props.placeholder}
              autoFocus
              onChange={(e) => setValue(e.target.value)}
            />
          ) : (
            <input
              className="input"
              value={value}
              placeholder={props.placeholder}
              autoFocus
              onChange={(e) => setValue(e.target.value)}
            />
          )}
        </label>
        <div className="flex justify-end gap-2">
          <button type="button" className="btn sm" onClick={() => props.onOpenChange(false)}>
            Cancel
          </button>
          <button type="submit" className="btn sm primary" disabled={!value.trim()}>
            {props.confirmLabel}
          </button>
        </div>
      </form>
    </Modal>
  )
}
