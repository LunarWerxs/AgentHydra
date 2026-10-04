import type { VariantProps } from "class-variance-authority"
import { cva } from "class-variance-authority"

export const tableVariants = cva('w-full caption-bottom text-xs', {
  variants: {
    density: {
      default: '',
      compact: '[&_td]:px-1.5 [&_th]:px-1.5',
    },
  },
  defaultVariants: {
    density: "default",
  },
})

export const tableRowVariants = cva('hover:bg-muted/50 data-[state=selected]:bg-muted border-b transition-colors has-aria-expanded:bg-muted/50', {
  variants: {
    variant: {
      default: '',
      tinted: 'bg-muted/40 hover:bg-muted/40',
      dimmed: 'opacity-60',
      faded: 'opacity-25 hover:bg-transparent transition-opacity',
    },
  },
  defaultVariants: {
    variant: "default",
  },
})

export type TableVariants = VariantProps<typeof tableVariants>
export type TableRowVariants = VariantProps<typeof tableRowVariants>
