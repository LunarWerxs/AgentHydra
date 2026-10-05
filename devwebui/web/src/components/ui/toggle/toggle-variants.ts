import type { VariantProps } from "class-variance-authority"
import { cva } from "class-variance-authority"

/**
 * Resting / hover / selected must stay visibly distinct on ANY container.
 *
 * This used to paint hover, `aria-pressed`, and `data-[state=on]` all with `bg-muted`, which the
 * theme defines as the same colour as `--secondary` and `--accent` (a shadcn neutral default we
 * keep). Two things broke: you could not tell a hovered item from the selected one, and on the
 * usual segmented-control track — `bg-secondary` — the item, its hover, and its selection were
 * literally one flat colour, so the control looked like an unclickable block.
 *
 * So neither state uses a container-family token any more. Hover is a translucent `foreground`
 * wash that reads over whatever it is placed on, and the selected item LIFTS to `bg-background`
 * with a shadow, which reads even when the track is `bg-background` itself. Every hover rule is
 * qualified by `data-[state=…]` so the attribute's specificity — not stylesheet order — decides
 * which of hover/selected wins; reka-ui's Toggle and ToggleGroupItem always set that attribute.
 */
export const toggleVariants = cva(
  'text-muted-foreground data-[state=off]:hover:bg-foreground/10 data-[state=off]:hover:text-foreground aria-pressed:text-foreground focus-visible:border-ring focus-visible:ring-ring/50 aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 aria-invalid:border-destructive data-[state=on]:bg-background data-[state=on]:hover:bg-background data-[state=on]:text-foreground data-[state=on]:shadow-sm gap-1 rounded-md text-xs font-medium transition-all [&_svg:not([class*=size-])]:size-4 group/toggle inline-flex items-center justify-center whitespace-nowrap outline-none focus-visible:ring-3 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0',
  {
    variants: {
      variant: {
        default: 'bg-transparent',
        outline: 'border-input border bg-transparent',
      },
      size: {
        default: 'h-7 min-w-7 px-2 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5',
        sm: 'h-6 min-w-6 rounded-[min(var(--radius-md),8px)] px-2 text-[0.625rem] has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 [&_svg:not([class*=size-])]:size-3',
        lg: 'h-8 min-w-8 px-2.5 has-data-[icon=inline-end]:pr-2 has-data-[icon=inline-start]:pl-2',
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  },
)

export type ToggleVariants = VariantProps<typeof toggleVariants>
