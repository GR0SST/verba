/* eslint-disable react-refresh/only-export-components */
import { createContext, useCallback, useContext, useRef, useState, type ReactNode } from "react"

import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@workspace/ui/components/alert-dialog"
import { Button } from "@workspace/ui/components/button"

type ConfirmOptions = { title: string; description?: ReactNode; confirmLabel?: string; destructive?: boolean }
type Confirm = (options: ConfirmOptions) => Promise<boolean>

const ConfirmContext = createContext<Confirm | undefined>(undefined)

/** In-app replacement for `window.confirm`: `if (await confirm({ title })) …` */
export function ConfirmProvider({ children }: { children: ReactNode }) {
  const [options, setOptions] = useState<ConfirmOptions>()
  const [open, setOpen] = useState(false)
  const resolveRef = useRef<(value: boolean) => void>(undefined)

  const confirm = useCallback<Confirm>((next) => {
    resolveRef.current?.(false)
    setOptions(next)
    setOpen(true)
    return new Promise((resolve) => {
      resolveRef.current = resolve
    })
  }, [])

  const settle = (value: boolean) => {
    resolveRef.current?.(value)
    resolveRef.current = undefined
    setOpen(false)
  }

  return (
    <ConfirmContext.Provider value={confirm}>
      {children}
      <AlertDialog onOpenChange={(next) => !next && settle(false)} open={open}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{options?.title}</AlertDialogTitle>
            {options?.description && <AlertDialogDescription>{options.description}</AlertDialogDescription>}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button onClick={() => settle(true)} variant={options?.destructive ? "destructive" : "default"}>{options?.confirmLabel ?? "Continue"}</Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </ConfirmContext.Provider>
  )
}

export function useConfirm() {
  const confirm = useContext(ConfirmContext)
  if (!confirm) throw new Error("useConfirm must be used inside ConfirmProvider")
  return confirm
}
