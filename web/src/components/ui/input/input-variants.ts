import type { VariantProps } from "class-variance-authority"
import { cva } from "class-variance-authority"

export const inputVariants = cva(
  'bg-input/20 dark:bg-input/30 border-input focus-visible:border-ring focus-visible:ring-ring/30 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:aria-invalid:border-destructive/50 h-7 rounded-md border px-2 py-0.5 text-sm transition-colors file:h-6 file:text-xs/relaxed file:font-medium focus-visible:ring-2 aria-invalid:ring-2 md:text-xs/relaxed w-full min-w-0 outline-none file:inline-flex file:border-0 file:bg-transparent file:text-foreground placeholder:text-muted-foreground disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-50',
  {
    variants: {
      variant: {
        default: '',
        mono: 'font-mono',
        quiet: 'border-transparent bg-secondary/25 dark:bg-secondary/25 hover:bg-secondary/40 focus-visible:border-ring/40 focus-visible:bg-secondary/40 focus-visible:ring-1',
        numeric: 'rounded px-1.5 text-end font-medium tabular-nums [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none',
        swatch: 'p-1',
      },
      textSize: {
        default: '',
        xs: 'text-xs',
        ui: 'text-ui md:text-ui',
      },
      leading: {
        none: '',
        "icon-sm": 'ps-7',
        icon: 'ps-8',
      },
      trailing: {
        none: '',
        "icon-sm": 'pe-7',
        icon: 'pe-8',
        action: 'pe-10',
        actions: 'pe-17',
      },
    },
    defaultVariants: {
      variant: "default",
      textSize: "default",
      leading: "none",
      trailing: "none",
    },
  },
)
export type InputVariants = VariantProps<typeof inputVariants>
