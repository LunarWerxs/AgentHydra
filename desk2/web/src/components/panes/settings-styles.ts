// The Settings dialog's button, text-field and menu looks, shared by its own rows, the AgentHydra rows and
// the Instances rows.
import { ITEM, MENU } from '@/components/composer/menu'

export const BUTTON =
  'flex h-7 shrink-0 cursor-default items-center rounded-[var(--radius-6)] bg-[var(--fill-secondary)] px-2.5 text-[13px] text-text transition-colors duration-[60ms] hover:bg-[var(--fill-secondary-hover)] focus-visible:shadow-[var(--focus-ring)] focus-visible:outline-none disabled:opacity-50'
export const FIELD =
  'h-7 rounded-[var(--radius-6)] bg-fill-5 px-2 text-[13px] text-text shadow-[inset_0_0_0_1px_var(--border)] outline-none focus:shadow-[var(--focus-ring)]'
export const SELECT_TRIGGER =
  'h-7 w-48 gap-1 rounded-[var(--radius-6)] border-0 bg-fill-5 px-2 text-[13px] leading-[19px] text-text shadow-[inset_0_0_0_1px_var(--border)] hover:bg-fill-hover data-[state=open]:bg-fill-hover focus-visible:ring-0 focus-visible:shadow-[var(--focus-ring)]'
export const SELECT_CONTENT = MENU + ' border-0'
export const SELECT_ITEM = ITEM + ' pr-8 text-text focus:text-text'
