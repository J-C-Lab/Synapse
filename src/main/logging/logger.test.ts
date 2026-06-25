import type { LogSink } from "./logger"
import { describe, expect, it } from "vitest"
import { Logger } from "./logger"

function memorySink(): LogSink & { records: Array<Record<string, unknown>> } {
  const records: Array<Record<string, unknown>> = []
  return { records, write: (line) => records.push(JSON.parse(line)) }
}

const fixedNow = () => new Date("2026-06-25T00:00:00.000Z")

describe("logger", () => {
  it("emits one JSON line per call with ts/level/scope/msg", () => {
    const sink = memorySink()
    const log = new Logger({ scope: "lan", sinks: [sink], now: fixedNow })
    log.info("started", { port: 5173 })
    expect(sink.records).toHaveLength(1)
    expect(sink.records[0]).toEqual({
      ts: "2026-06-25T00:00:00.000Z",
      level: "info",
      scope: "lan",
      msg: "started",
      port: 5173,
    })
  })

  it("redacts secret fields", () => {
    const sink = memorySink()
    new Logger({ sinks: [sink], now: fixedNow }).warn("auth", { apiKey: "sk-secret" })
    expect(sink.records[0].apiKey).toBe("[redacted]")
  })

  it("filters records below minLevel", () => {
    const sink = memorySink()
    const log = new Logger({ sinks: [sink], minLevel: "warn", now: fixedNow })
    log.debug("d")
    log.info("i")
    log.warn("w")
    log.error("e")
    expect(sink.records.map((r) => r.level)).toEqual(["warn", "error"])
  })

  it("child() prefixes scope and merges bound fields", () => {
    const sink = memorySink()
    const root = new Logger({ scope: "plugin", sinks: [sink], now: fixedNow })
    root.child("registry", { pluginId: "com.x" }).error("load failed", { code: 1 })
    expect(sink.records[0]).toMatchObject({
      scope: "plugin:registry",
      pluginId: "com.x",
      code: 1,
      msg: "load failed",
    })
  })

  it("normalizes Error field values to message + stack", () => {
    const sink = memorySink()
    new Logger({ sinks: [sink], now: fixedNow }).error("boom", { err: new Error("nope") })
    const err = sink.records[0].err as { message: string; stack?: string }
    expect(err.message).toBe("nope")
    expect(typeof err.stack).toBe("string")
  })
})
