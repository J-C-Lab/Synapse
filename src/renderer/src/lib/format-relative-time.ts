const UNITS: { unit: Intl.RelativeTimeFormatUnit; ms: number }[] = [
  { unit: "year", ms: 365 * 24 * 60 * 60 * 1000 },
  { unit: "month", ms: 30 * 24 * 60 * 60 * 1000 },
  { unit: "day", ms: 24 * 60 * 60 * 1000 },
  { unit: "hour", ms: 60 * 60 * 1000 },
  { unit: "minute", ms: 60 * 1000 },
]

/** Locale-aware "2 hours ago" / "5 分钟前" style formatting for a timestamp. */
export function formatRelativeTime(timestamp: number, locale: string, now = Date.now()): string {
  const diffMs = timestamp - now
  const formatter = new Intl.RelativeTimeFormat(locale, { numeric: "auto" })
  for (const { unit, ms } of UNITS) {
    if (Math.abs(diffMs) >= ms) {
      return formatter.format(Math.round(diffMs / ms), unit)
    }
  }
  return formatter.format(0, "minute")
}
