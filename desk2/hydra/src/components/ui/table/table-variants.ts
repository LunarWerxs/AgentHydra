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

// The hover is --accent: tables sit on cards, and in the dark theme --muted IS the card colour (style.css).
export const tableRowVariants = cva('hover:bg-accent data-[state=selected]:bg-muted border-b transition-colors has-aria-expanded:bg-accent', {
  variants: {
    variant: {
      default: '',
      tinted: 'bg-muted/40 hover:bg-accent/70 has-aria-expanded:bg-accent/70',
      dimmed: 'opacity-60',
      faded: 'opacity-25 hover:bg-transparent has-aria-expanded:bg-transparent transition-opacity',
    },
  },
  defaultVariants: {
    variant: "default",
  },
})

export type TableVariants = VariantProps<typeof tableVariants>
export type TableRowVariants = VariantProps<typeof tableRowVariants>
