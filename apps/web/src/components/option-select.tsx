import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@workspace/ui/components/select"
import { cn } from "@workspace/ui/lib/utils"

export type SelectOption<T extends string> = { value: T; label: string }

/** Trigger looks for each surface the dropdown sits on. */
const VARIANTS = {
  field: "bg-background data-[size=default]:h-9 dark:bg-background dark:hover:bg-card",
  settings: "w-auto min-w-44 shrink-0 bg-card text-[13px] dark:bg-card dark:hover:bg-popover",
  player: "border-white/10 text-[12px] text-white dark:bg-white/5 dark:hover:bg-white/10",
}

/** Styled dropdown that opens below its trigger (the native macOS menu covers the field and ignores the theme). */
export function OptionSelect<T extends string>({
  value,
  options,
  onChange,
  label,
  id,
  disabled,
  variant = "field",
  className,
  contentClassName,
}: {
  value: T
  options: Array<SelectOption<T>>
  onChange: (value: T) => void
  label?: string
  id?: string
  disabled?: boolean
  variant?: keyof typeof VARIANTS
  className?: string
  contentClassName?: string
}) {
  return (
    <Select disabled={disabled} items={options} onValueChange={(next) => next !== null && onChange(next as T)} value={value}>
      <SelectTrigger aria-label={label} className={cn("w-full", VARIANTS[variant], className)} id={id}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="start" alignItemWithTrigger={false} className={cn("max-h-72", contentClassName)}>
        {options.map((option) => (
          <SelectItem key={option.value} value={option.value}>{option.label}</SelectItem>
        ))}
      </SelectContent>
    </Select>
  )
}
