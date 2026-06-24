import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createFileSink } from "./file-sink"

let dir: string
beforeEach(() => {
  dir = mkdtempSync(path.join(tmpdir(), "synapse-log-"))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe("createFileSink", () => {
  it("creates the directory and appends lines to main.log", () => {
    const sub = path.join(dir, "logs")
    const sink = createFileSink(sub)
    sink.write("a\n")
    sink.write("b\n")
    expect(readFileSync(path.join(sub, "main.log"), "utf-8")).toBe("a\nb\n")
  })

  it("rotates main.log to main.1.log when it exceeds maxBytes", () => {
    const sink = createFileSink(dir, { maxBytes: 10, keep: 3 })
    sink.write("123456789\n") // 10 bytes — at/over threshold
    sink.write("next\n") // triggers rotation before writing
    expect(readFileSync(path.join(dir, "main.1.log"), "utf-8")).toBe("123456789\n")
    expect(readFileSync(path.join(dir, "main.log"), "utf-8")).toBe("next\n")
  })

  it("keeps at most `keep` archives, dropping the oldest", () => {
    const sink = createFileSink(dir, { maxBytes: 5, keep: 2 })
    for (const line of ["aaaa\n", "bbbb\n", "cccc\n", "dddd\n"]) sink.write(line)
    // keep=2 → main.1.log and main.2.log exist, main.3.log does not.
    expect(existsSync(path.join(dir, "main.1.log"))).toBe(true)
    expect(existsSync(path.join(dir, "main.2.log"))).toBe(true)
    expect(existsSync(path.join(dir, "main.3.log"))).toBe(false)
  })

  it("picks up the size of a pre-existing log file", () => {
    writeFileSync(path.join(dir, "main.log"), "0123456789\n")
    const sink = createFileSink(dir, { maxBytes: 5, keep: 2 })
    sink.write("x\n") // existing file already over threshold → rotate first
    expect(readFileSync(path.join(dir, "main.1.log"), "utf-8")).toBe("0123456789\n")
    expect(readFileSync(path.join(dir, "main.log"), "utf-8")).toBe("x\n")
  })
})
