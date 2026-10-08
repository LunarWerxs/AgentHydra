// A cap on a menu's width, for menus whose rows carry long names; the menu still shrinks to fit shorter ones.
export type MenuWidth = "sm" | "md" | "lg"

export const MENU_WIDTH: Record<MenuWidth, string> = {
  sm: 'max-w-52',
  md: 'max-w-56',
  lg: 'max-w-64',
}
