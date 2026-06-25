import { redactFields } from "./redact"

// Pure structured logger for the main process. Each call emits one JSON line
// ({ ts, level, scope, msg, ...fields }) to every injected sink. Provider-neutral
// about where lines go (file, stderr, memory in tests) — the sinks decide. Never
// touches stdout itself; that's a sink's concern and the wired sinks avoid it.

export type LogLevel = "debug" | "info" | "warn" | "error"

export interface LogSink {
  write: (line: string) => void
}

export interface LoggerOptions {
  scope?: string
  minLevel?: LogLevel
  sinks: LogSink[]
  bound?: Record<string, unknown>
  now?: () => Date
}

const ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 }

export class Logger {
  constructor(private readonly options: LoggerOptions) {}

  /** A sub-logger with a nested scope and extra fields bound to every record. */
  child(scope: string, fields?: Record<string, unknown>): Logger {
    return new Logger({
      ...this.options,
      scope: this.options.scope ? `${this.options.scope}:${scope}` : scope,
      bound: { ...this.options.bound, ...fields },
    })
  }

  debug(msg: string, fields?: Record<string, unknown>): void {
    this.emit("debug", msg, fields)
  }

  info(msg: string, fields?: Record<string, unknown>): void {
    this.emit("info", msg, fields)
  }

  warn(msg: string, fields?: Record<string, unknown>): void {
    this.emit("warn", msg, fields)
  }

  error(msg: string, fields?: Record<string, unknown>): void {
    this.emit("error", msg, fields)
  }

  private emit(level: LogLevel, msg: string, fields?: Record<string, unknown>): void {
    if (ORDER[level] < ORDER[this.options.minLevel ?? "info"]) return
    const merged = normalizeErrors({ ...this.options.bound, ...fields })
    const record = {
      ts: (this.options.now?.() ?? new Date()).toISOString(),
      level,
      scope: this.options.scope,
      msg,
      ...(redactFields(merged) as Record<string, unknown>),
    }
    const line = `${JSON.stringify(record)}\n`
    for (const sink of this.options.sinks) sink.write(line)
  }
}

// Errors don't JSON-serialize usefully (they stringify to `{}`), so surface the
// message and stack as plain fields.
function normalizeErrors(fields: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const [key, value] of Object.entries(fields)) {
    out[key] = value instanceof Error ? { message: value.message, stack: value.stack } : value
  }
  return out
}
