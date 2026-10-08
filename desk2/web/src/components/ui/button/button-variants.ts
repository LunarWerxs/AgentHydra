import type { VariantProps } from "class-variance-authority"
import { cva } from "class-variance-authority"

export const buttonVariants = cva(
  'focus-visible:border-accent focus-visible:ring-accent/30 aria-invalid:ring-danger/20 dark:aria-invalid:ring-danger/40 aria-invalid:border-danger dark:aria-invalid:border-danger/50 rounded-md border border-transparent bg-clip-padding text-xs/relaxed font-medium focus-visible:ring-2 aria-invalid:ring-2 active:not-aria-[haspopup]:translate-y-px [&_svg:not([class*=size-])]:size-4 group/button inline-flex shrink-0 items-center justify-center whitespace-nowrap transition outline-none select-none disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-brand text-white hover:bg-brand/80',
        outline: 'border-border dark:bg-fill-5 hover:bg-fill-5 hover:text-text aria-expanded:bg-fill-5 aria-expanded:text-text data-[active=true]:border-brand/50 data-[active=true]:text-text',
        dashed: 'border-dashed border-border dark:bg-fill-5 hover:bg-fill-5 hover:text-text aria-expanded:bg-fill-5 aria-expanded:text-text',
        overlay: 'border-border bg-bg-page/90 dark:bg-fill-5 text-text shadow-sm backdrop-blur hover:bg-fill-hover hover:text-text aria-expanded:bg-fill-5 aria-expanded:text-text',
        "overlay-destructive": 'border-border bg-bg-page/90 dark:bg-fill-5 text-danger-text shadow-sm backdrop-blur hover:bg-danger hover:text-white aria-expanded:bg-fill-5 aria-expanded:text-text',
        secondary: 'bg-fill-selected text-text hover:bg-fill-selected aria-expanded:bg-fill-selected aria-expanded:text-text',
        ghost: 'hover:bg-fill-5 hover:text-text dark:hover:bg-fill-5 aria-expanded:bg-fill-5 aria-expanded:text-text',
        "ghost-destructive": 'text-danger-text hover:bg-danger/10 hover:text-danger-text dark:hover:bg-fill-5 aria-expanded:bg-fill-5 aria-expanded:text-text',
        "ghost-destructive-muted": 'text-text-muted hover:bg-fill-5 hover:text-danger-text dark:hover:bg-fill-5 aria-expanded:bg-fill-5 aria-expanded:text-text',
        destructive: 'bg-danger/10 hover:bg-danger/20 focus-visible:ring-danger/20 dark:focus-visible:ring-danger/40 dark:bg-danger/20 text-danger-text focus-visible:border-danger/40 dark:hover:bg-danger/30',
        link: 'text-brand underline-offset-4 hover:underline',
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
