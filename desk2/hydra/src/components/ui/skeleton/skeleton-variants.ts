import type { VariantProps } from "class-variance-authority"
import { cva } from "class-variance-authority"

// A placeholder's height (the line it stands in for) and width, so a table can name each column's skeleton as data.
export const skeletonVariants = cva('', {
  variants: {
    line: {
      none: '',
      dot: 'size-2',
      text: 'h-3',
      title: 'h-4',
      chip: 'h-5',
      button: 'h-6',
    },
    width: {
      none: '',
      '8': 'w-8',
      '10': 'w-10',
      '12': 'w-12',
      '14': 'w-14',
      '16': 'w-16',
      '20': 'w-20',
      '24': 'w-24',
      '28': 'w-28',
      '32': 'w-32',
    },
  },
  defaultVariants: {
    line: "none",
    width: "none",
  },
})

export type SkeletonVariants = VariantProps<typeof skeletonVariants>
