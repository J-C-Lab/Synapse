import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import process from "node:process"
import { resolveAbsolutePath, watchDirectoryForPattern } from "@synapse/plugin-manifest"
import { describe, expect, it, vi } from "vitest"
import {
  FsPathEscapeError,
  readVerifiedText,
  resolveVerifiedAbsolutePath,
  safeScopedStat,
} from "./fs-path-resolver"

const HOME = "/home/alice"
const PATTERN = "~/Downloads/**"
const WATCH_ROOT = "/home/alice/Downloads"

describe("resolveVerifiedAbsolutePath", () => {
  it("rejects symlink hops that escape the declared watch root", async () => {
    const lexical = resolveAbsolutePath(HOME, PATTERN, "leak")
    expect(lexical).toBe(`${WATCH_ROOT}/leak`)

    const io = {
      realpath: vi.fn(async (target: string) => {
        if (target === WATCH_ROOT) return WATCH_ROOT
        if (target === lexical) return "/home/alice/.ssh/id_rsa"
        throw new Error(`unexpected realpath: ${target}`)
      }),
      lstat: vi.fn(async () => ({
        isSymbolicLink: () => true,
        isFile: () => false,
        size: 0,
      })),
      readFile: vi.fn(),
    }

    await expect(resolveVerifiedAbsolutePath(HOME, PATTERN, "leak", io)).rejects.toBeInstanceOf(
      FsPathEscapeError
    )
  })

  it("rejects regular files whose real path escapes the watch root", async () => {
    const lexical = resolveAbsolutePath(HOME, PATTERN, "nested/file.txt")
    const io = {
      realpath: vi.fn(async (target: string) => {
        if (target === WATCH_ROOT) return WATCH_ROOT
        if (target === lexical) return "/etc/passwd"
        throw new Error(`unexpected realpath: ${target}`)
      }),
      lstat: vi.fn(async () => ({
        isSymbolicLink: () => false,
        isFile: () => true,
        size: 1,
      })),
      readFile: vi.fn(),
    }

    await expect(resolveVerifiedAbsolutePath(HOME, PATTERN, "nested/file.txt", io)).rejects.toThrow(
      /escapes declared fs scope/
    )
  })

  it("allows a regular file that stays inside the real watch root", async () => {
    const lexical = resolveAbsolutePath(HOME, PATTERN, "ok.txt")
    const io = {
      realpath: vi.fn(async (target: string) => target),
      lstat: vi.fn(async () => ({
        isSymbolicLink: () => false,
        isFile: () => true,
        size: 4,
      })),
      readFile: vi.fn(async () => "data"),
    }

    await expect(resolveVerifiedAbsolutePath(HOME, PATTERN, "ok.txt", io)).resolves.toBe(lexical)
    await expect(readVerifiedText(HOME, PATTERN, "ok.txt", io)).resolves.toBe("data")
  })
})

describe("safeScopedStat", () => {
  it("returns undefined for symlink paths instead of leaking target metadata", async () => {
    const io = {
      realpath: vi.fn(async (target: string) => target),
      lstat: vi.fn(async () => ({
        isSymbolicLink: () => true,
        isFile: () => false,
        size: 999,
      })),
      readFile: vi.fn(),
    }

    await expect(safeScopedStat(HOME, PATTERN, "leak", io)).resolves.toBeUndefined()
  })
})

describe("watchDirectoryForPattern", () => {
  it("anchors verification to the declared watch directory", () => {
    expect(watchDirectoryForPattern(PATTERN, HOME)).toBe(WATCH_ROOT)
  })
})

// Real-filesystem defense-in-depth check (POSIX only — Windows symlink creation
// needs elevation). The unit tests above inject `io` and verify the LOGIC;
// these exercise the real fs.realpath / lstat / O_NOFOLLOW path end-to-end.
describe.skipIf(process.platform === "win32")("real filesystem symlink escape", () => {
  it("reads a regular file but rejects a symlink that escapes the watch root", async () => {
    const home = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-fsr-"))
    const downloads = path.join(home, "Downloads")
    await fs.mkdir(downloads, { recursive: true })

    const secret = path.join(home, "secret.txt")
    await fs.writeFile(secret, "TOP SECRET", "utf8")
    await fs.writeFile(path.join(downloads, "report.txt"), "hello", "utf8")
    await fs.symlink(secret, path.join(downloads, "leak.txt"))

    try {
      await expect(readVerifiedText(home, "~/Downloads/**", "report.txt")).resolves.toBe("hello")

      await expect(readVerifiedText(home, "~/Downloads/**", "leak.txt")).rejects.toBeInstanceOf(
        FsPathEscapeError
      )
      await expect(
        resolveVerifiedAbsolutePath(home, "~/Downloads/**", "leak.txt")
      ).rejects.toBeInstanceOf(FsPathEscapeError)
      await expect(safeScopedStat(home, "~/Downloads/**", "leak.txt")).resolves.toBeUndefined()
    } finally {
      await fs.rm(home, { recursive: true, force: true })
    }
  })
})
