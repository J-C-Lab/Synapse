import type { LogSink } from "./logger"
import { Buffer } from "node:buffer"
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs"
import * as path from "node:path"
import process from "node:process"

// A LogSink that appends lines to `<dir>/main.log` and rotates it by size:
// when the file reaches `maxBytes`, it shifts to `main.1.log` … `main.<keep>.log`
// (oldest dropped). Synchronous + low-volume by design — the main process logs
// events, not a firehose, and sync writes keep ordering simple and crash-safe.

export interface FileSinkOptions {
  maxBytes?: number
  keep?: number
  /** Log file name within `dir`; rotation archives as `<base>.1.log` … Default `main.log`. */
  fileName?: string
}

export function createFileSink(dir: string, options: FileSinkOptions = {}): LogSink {
  const maxBytes = options.maxBytes ?? 5_000_000
  const keep = options.keep ?? 3
  const fileName = options.fileName ?? "main.log"
  const base = fileName.replace(/\.log$/, "")
  const current = path.join(dir, fileName)
  mkdirSync(dir, { recursive: true })
  let size = existsSync(current) ? statSync(current).size : 0

  return {
    write(line) {
      if (size >= maxBytes) {
        rotate(dir, base, keep)
        size = 0
      }
      appendFileSync(current, line)
      size += Buffer.byteLength(line)
    },
  }
}

function rotate(dir: string, base: string, keep: number): void {
  const archive = (n: number) => path.join(dir, `${base}.${n}.log`)
  const oldest = archive(keep)
  if (existsSync(oldest)) rmSync(oldest)
  for (let i = keep - 1; i >= 1; i--) {
    const from = archive(i)
    if (existsSync(from)) renameSync(from, archive(i + 1))
  }
  const current = path.join(dir, `${base}.log`)
  if (existsSync(current)) renameSync(current, archive(1))
}

// Writes to stderr (never stdout — see the MCP stdio invariant).
export const stderrSink: LogSink = {
  write: (line) => {
    process.stderr.write(line)
  },
}
