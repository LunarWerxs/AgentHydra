import type { VariantProps } from "class-variance-authority"
import { cva } from "class-variance-authority"

export const textareaVariants = cva(
  'border-input bg-input/20 dark:bg-input/30 focus-visible:border-ring focus-visible:ring-ring/30 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:aria-invalid:border-destructive/50 resize-none rounded-md border p-2 text-sm transition-colors focus-visible:ring-2 aria-invalid:ring-2 md:text-xs/relaxed flex field-sizing-content min-h-16 w-full outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50',
  {
    variants: {
      variant: {
        default: '',
        mono: 'font-mono',
        embedded: 'border-0 bg-transparent dark:bg-transparent focus-visible:ring-0 px-3 pt-2.5',
      },
      textSize: {
        default: '',
        "2xs": 'text-2xs/snug md:text-2xs/snug',
        xs: 'text-xs',
        ui: 'text-ui md:text-ui',
      },
      density: {
        default: '',
        compact: 'py-1.5 leading-snug',
      },
      trailing: {
        none: '',
        action: 'pe-10',
        actions: 'pe-17',
      },
    },
    defaultVariants: {
      variant: "default",
      textSize: "default",
      density: "default",
      trailing: "none",
    },
  },
)
export type TextareaVariants = VariantProps<typeof textareaVariants>
