import { type ClassValue, clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** Standard shadcn-vue class merge helper (copied from AgentHydra's web/src/lib/utils.ts). */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
