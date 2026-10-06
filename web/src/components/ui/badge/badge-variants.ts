import type { VariantProps } from "class-variance-authority"
import { cva } from "class-variance-authority"

export const badgeVariants = cva(
  'h-5 gap-1 rounded-full border border-transparent px-2 py-0.5 text-[0.625rem] font-medium transition has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&>svg]:size-2.5! group/badge inline-flex w-fit shrink-0 items-center justify-center overflow-hidden whitespace-nowrap focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground [a]:hover:bg-primary/80',
        secondary: 'bg-secondary text-secondary-foreground [a]:hover:bg-secondary/80',
        destructive: 'bg-destructive/10 [a]:hover:bg-destructive/20 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 text-destructive dark:bg-destructive/20',
        primary: 'bg-primary/10 text-primary dark:bg-primary/20',
        success: 'bg-success/10 text-success dark:bg-success/20',
        warning: 'bg-warning/10 text-warning dark:bg-warning/20',
        info: 'bg-info/10 text-info dark:bg-info/20',
        outline: 'border-border text-foreground [a]:hover:bg-muted [a]:hover:text-muted-foreground bg-input/20 dark:bg-input/30',
        ghost: 'hover:bg-muted hover:text-muted-foreground dark:hover:bg-muted/50',
        link: 'text-primary underline-offset-4 hover:underline',
        muted: 'border-border bg-muted text-muted-foreground',
      },
      size: {
        default: '',
        sm: 'px-1',
      },
      dimmed: {
        true: 'opacity-60',
        false: '',
      },
      interactive: {
        true: 'cursor-pointer disabled:cursor-default disabled:opacity-70',
        false: '',
      },
    },
    compoundVariants: [
      { interactive: true, variant: "default", class: 'hover:bg-primary/80' },
      { interactive: true, variant: "secondary", class: 'hover:bg-secondary/80' },
      { interactive: true, variant: "destructive", class: 'hover:bg-destructive/20 dark:hover:bg-destructive/30' },
      { interactive: true, variant: "primary", class: 'hover:bg-primary/20 dark:hover:bg-primary/30' },
      { interactive: true, variant: "success", class: 'hover:bg-success/20 dark:hover:bg-success/30' },
      { interactive: true, variant: "warning", class: 'hover:bg-warning/20 dark:hover:bg-warning/30' },
      { interactive: true, variant: "info", class: 'hover:bg-info/20 dark:hover:bg-info/30' },
      { interactive: true, variant: ["outline", "muted"], class: 'hover:bg-muted hover:text-muted-foreground' },
    ],
    defaultVariants: {
      variant: "default",
      size: "default",
      dimmed: false,
      interactive: false,
    },
  },
)
export type BadgeVariants = VariantProps<typeof badgeVariants>
