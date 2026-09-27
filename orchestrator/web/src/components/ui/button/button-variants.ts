import type { VariantProps } from "class-variance-authority"
import { cva } from "class-variance-authority"

export const buttonVariants = cva(
  'focus-visible:border-ring focus-visible:ring-ring/30 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive dark:aria-invalid:border-destructive/50 rounded-md border border-transparent bg-clip-padding text-xs/relaxed font-medium focus-visible:ring-2 aria-invalid:ring-2 active:not-aria-[haspopup]:translate-y-px [&_svg:not([class*=size-])]:size-4 group/button inline-flex shrink-0 items-center justify-center whitespace-nowrap transition-all outline-none select-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-primary text-primary-foreground hover:bg-primary/80',
        outline: 'border-border dark:bg-input/30 hover:bg-input/50 hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground data-[active=true]:border-primary/50 data-[active=true]:text-foreground',
        dashed: 'border-dashed border-border dark:bg-input/30 hover:bg-input/50 hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground',
        overlay: 'border-border bg-background/90 dark:bg-input/30 text-foreground shadow-sm backdrop-blur hover:bg-accent hover:text-foreground aria-expanded:bg-muted aria-expanded:text-foreground',
        "overlay-destructive": 'border-border bg-background/90 dark:bg-input/30 text-destructive shadow-sm backdrop-blur hover:bg-destructive hover:text-destructive-foreground aria-expanded:bg-muted aria-expanded:text-foreground',
        secondary: 'bg-secondary text-secondary-foreground hover:bg-secondary/80 aria-expanded:bg-secondary aria-expanded:text-secondary-foreground',
        ghost: 'hover:bg-muted hover:text-foreground dark:hover:bg-muted/50 aria-expanded:bg-muted aria-expanded:text-foreground',
        "ghost-destructive": 'text-destructive hover:bg-destructive/10 hover:text-destructive dark:hover:bg-muted/50 aria-expanded:bg-muted aria-expanded:text-foreground',
        "ghost-destructive-muted": 'text-muted-foreground hover:bg-muted hover:text-destructive dark:hover:bg-muted/50 aria-expanded:bg-muted aria-expanded:text-foreground',
        destructive: 'bg-destructive/10 hover:bg-destructive/20 focus-visible:ring-destructive/20 dark:focus-visible:ring-destructive/40 dark:bg-destructive/20 text-destructive focus-visible:border-destructive/40 dark:hover:bg-destructive/30',
        link: 'text-primary underline-offset-4 hover:underline',
        gemini: 'border-transparent text-white bg-gemini animate-gemini-pan hover:brightness-108 hover:saturate-108',
      },
      size: {
        "default": 'h-7 gap-1 px-2 text-xs/relaxed has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*=size-])]:size-3.5',
        "xs": 'h-5 gap-1 rounded-sm px-2 text-[0.625rem] has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*=size-])]:size-2.5',
        "sm": 'h-6 gap-1 px-2 text-xs/relaxed has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*=size-])]:size-3',
        "lg": 'h-8 gap-1 px-2.5 text-xs/relaxed has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2 [&_svg:not([class*=size-])]:size-4',
        "inline": 'h-auto gap-1 p-0 align-baseline [&_svg:not([class*=size-])]:size-3',
        "compact": 'h-auto gap-1 px-1 py-0.5 [&_svg:not([class*=size-])]:size-3',
        "row": 'h-auto justify-start gap-2 rounded-lg px-2 py-1.5 text-start font-normal focus-visible:ring-inset [&_svg:not([class*=size-])]:size-3.5',
        "icon": 'size-7 [&_svg:not([class*=size-])]:size-3.5',
        "icon-xs": 'size-5 rounded-sm [&_svg:not([class*=size-])]:size-2.5',
        "icon-xs-round": 'size-5 rounded-full [&_svg:not([class*=size-])]:size-2.5',
        "icon-sm": 'size-6 [&_svg:not([class*=size-])]:size-3',
        "icon-lg": 'size-8 [&_svg:not([class*=size-])]:size-4',
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
)
export type ButtonVariants = VariantProps<typeof buttonVariants>
