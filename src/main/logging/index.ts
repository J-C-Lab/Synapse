import type { LogLevel } from "./logger"
import * as path from "node:path"
import process from "node:process"
import { createFileSink, stderrSink } from "./file-sink"
import { Logger } from "./logger"

// The main process's root logger. It's a convention singleton — logging is
// legitimately ambient, so threading a Logger through every service's
// constructor would be pure churn. Modules `import { logger }` and call
// `logger.child("scope").info(...)` at the call site.
//
// Before `configureRootLogger` runs (very early in index.ts, once userData is
// known), records go to stderr only. After, they also append to a rotating
// file. Output never touches stdout — preserving the MCP-stdio invariant.

export { Logger } from "./logger"
export type { LogLevel, LogSink } from "./logger"

function defaultLevel(): LogLevel {
  const raw = process.env.SYNAPSE_LOG_LEVEL?.toLowerCase()
  return raw === "debug" || raw === "info" || raw === "warn" || raw === "error" ? raw : "info"
}

let root = new Logger({ minLevel: defaultLevel(), sinks: [stderrSink] })

export interface ConfigureRootLoggerOptions {
  userDataDir: string
  level?: LogLevel
}

export function configureRootLogger(options: ConfigureRootLoggerOptions): void {
  root = new Logger({
    minLevel: options.level ?? defaultLevel(),
    sinks: [stderrSink, createFileSink(path.join(options.userDataDir, "logs"))],
  })
}

// A thin facade that resolves the current `root` at call time, so modules that
// imported `logger` before configuration still log through the configured root.
export const logger = {
  debug: (msg: string, fields?: Record<string, unknown>) => root.debug(msg, fields),
  info: (msg: string, fields?: Record<string, unknown>) => root.info(msg, fields),
  warn: (msg: string, fields?: Record<string, unknown>) => root.warn(msg, fields),
  error: (msg: string, fields?: Record<string, unknown>) => root.error(msg, fields),
  child: (scope: string, fields?: Record<string, unknown>) => root.child(scope, fields),
}
