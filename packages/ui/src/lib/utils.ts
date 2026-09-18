import type { ClassValue } from "clsx";
import { clsx } from "clsx";
import { twMerge } from "tailwind-merge";

/** Merge Tailwind class lists (Solid UI convention). */
export function cn(...inputs: ClassValue[]): string {
  return twMerge(clsx(inputs));
}
