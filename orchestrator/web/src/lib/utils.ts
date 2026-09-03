import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** Standard shadcn-vue class merge helper. Shared verbatim across all apps. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
