import { clsx, type ClassValue } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

/**
 * The year of a TMDB date ("2020-01-01"). Read from the text: `new Date()`
 * parses a bare date as UTC midnight, which is still the previous day (and,
 * for TMDB's common Jan 1 placeholder, the previous year) west of Greenwich.
 */
export function yearOf(date: string | null | undefined): number | null {
  const match = date ? /^(\d{4})-/.exec(date) : null;
  return match ? Number(match[1]) : null;
}
