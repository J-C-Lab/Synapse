/** Parsed 5-field crontab (minute hour dom month dow). */
export interface CronFields {
  minute: readonly number[]
  hour: readonly number[]
  dayOfMonth: readonly number[]
  month: readonly number[]
  dayOfWeek: readonly number[]
}

const DEFAULT_MIN_INTERVAL_MS = 60_000

function parseField(field: string, min: number, max: number): readonly number[] {
  const trimmed = field.trim()
  if (!trimmed) throw new TypeError("cron field must not be empty")

  const values = new Set<number>()
  for (const chunk of trimmed.split(",")) {
    const part = chunk.trim()
    if (!part) throw new TypeError("cron field contains an empty segment")

    let base = part
    let step = 1
    if (part.includes("/")) {
      const slash = part.indexOf("/")
      base = part.slice(0, slash).trim()
      step = Number(part.slice(slash + 1))
      if (!Number.isInteger(step) || step <= 0)
        throw new TypeError(`cron field has an invalid step: ${part}`)
    }

    let start: number
    let end: number
    if (base === "*" || base === "") {
      start = min
      end = max
    } else if (base.includes("-")) {
      const dash = base.indexOf("-")
      start = Number(base.slice(0, dash))
      end = Number(base.slice(dash + 1))
    } else {
      start = Number(base)
      end = start
    }

    if (!Number.isInteger(start) || !Number.isInteger(end))
      throw new TypeError(`cron field has invalid numbers: ${part}`)
    if (start < min || end > max || start > end)
      throw new TypeError(`cron field out of range: ${part}`)

    for (let value = start; value <= end; value += step) values.add(value)
  }

  return [...values].sort((a, b) => a - b)
}

function normalizeDayOfWeek(values: readonly number[]): readonly number[] {
  const out = new Set<number>()
  for (const value of values) {
    if (value === 7) out.add(0)
    else out.add(value)
  }
  return [...out].sort((a, b) => a - b)
}

/** Collapse whitespace; returns five fields joined by single spaces. */
export function normalizeCronExpression(raw: string): string {
  const parts = raw.trim().split(/\s+/).filter(Boolean)
  if (parts.length !== 5) throw new TypeError("cron expression must have exactly five fields")
  return parts.join(" ")
}

export function parseCronExpression(raw: string): CronFields {
  const normalized = normalizeCronExpression(raw)
  const [minute, hour, dayOfMonth, month, dayOfWeek] = normalized.split(" ")
  return {
    minute: parseField(minute!, 0, 59),
    hour: parseField(hour!, 0, 23),
    dayOfMonth: parseField(dayOfMonth!, 1, 31),
    month: parseField(month!, 1, 12),
    dayOfWeek: normalizeDayOfWeek(parseField(dayOfWeek!, 0, 7)),
  }
}

function isFullRange(values: readonly number[], min: number, max: number): boolean {
  return values.length === max - min + 1
}

function matchesLocalTime(date: Date, fields: CronFields): boolean {
  const minute = date.getMinutes()
  const hour = date.getHours()
  const dom = date.getDate()
  const month = date.getMonth() + 1
  const dow = date.getDay()

  if (!fields.minute.includes(minute)) return false
  if (!fields.hour.includes(hour)) return false
  if (!fields.month.includes(month)) return false

  const domAny = isFullRange(fields.dayOfMonth, 1, 31)
  const dowAny = isFullRange(fields.dayOfWeek, 0, 6)
  const domMatch = fields.dayOfMonth.includes(dom)
  const dowMatch = fields.dayOfWeek.includes(dow)

  if (domAny && dowAny) return true
  if (domAny) return dowMatch
  if (dowAny) return domMatch
  return domMatch || dowMatch
}

function toLocalDate(ms: number): Date {
  return new Date(ms)
}

/** Next fire time (epoch ms) strictly after `afterMs`, using local timezone. */
export function nextCronFire(afterMs: number, rawExpression: string): number {
  const fields = parseCronExpression(rawExpression)
  const cursor = toLocalDate(afterMs)
  cursor.setSeconds(0, 0)
  cursor.setMilliseconds(0)
  cursor.setMinutes(cursor.getMinutes() + 1)

  const limit = cursor.getTime() + 366 * 24 * 60 * 60 * 1000
  while (cursor.getTime() < limit) {
    if (matchesLocalTime(cursor, fields)) return cursor.getTime()
    cursor.setMinutes(cursor.getMinutes() + 1)
  }
  throw new TypeError(`cron expression never fires: ${rawExpression}`)
}

// Fixed reference anchor so the min-interval check is reproducible regardless of
// when validation runs (was Date.now(), which made the result wall-clock
// dependent near month/DST boundaries). A leap-year start covering all
// months/weekdays; 64 consecutive fires comfortably span the densest minute
// spacing a 5-field cron can express, so the global minimum gap is found.
const SAMPLE_ANCHOR_MS = Date.UTC(2024, 0, 1, 0, 0, 0)

function minimumIntervalMs(rawExpression: string, samples = 64): number {
  let after = SAMPLE_ANCHOR_MS
  let previous: number | undefined
  let minGap = Number.POSITIVE_INFINITY
  for (let i = 0; i < samples; i++) {
    const next = nextCronFire(after, rawExpression)
    if (previous !== undefined) minGap = Math.min(minGap, next - previous)
    previous = next
    after = next
  }
  return minGap
}

export interface ValidateCronOptions {
  minIntervalMs?: number
}

export function validateCronExpression(raw: unknown, options: ValidateCronOptions = {}): void {
  if (typeof raw !== "string" || raw.trim().length === 0)
    throw new TypeError("cron schedule must be a non-empty 5-field string")
  const normalized = normalizeCronExpression(raw)
  parseCronExpression(normalized)
  const minIntervalMs = options.minIntervalMs ?? DEFAULT_MIN_INTERVAL_MS
  const gap = minimumIntervalMs(normalized)
  if (gap < minIntervalMs)
    throw new TypeError(
      `cron schedule fires more often than the ${minIntervalMs}ms minimum interval (${normalized})`
    )
}

export function summarizeCronExpression(raw: string): string {
  return normalizeCronExpression(raw)
}
