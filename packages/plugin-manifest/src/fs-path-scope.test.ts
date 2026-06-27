import { describe, expect, it } from "vitest"
import {
  fsPathAdapter as a,
  expandHomePath,
  resolveAbsolutePath,
  rootIdForPattern,
  validateSettle,
} from "./fs-path-scope"

const HOME = "/home/alice"

describe("validate", () => {
  it("rejects empty paths", () => expect(() => a.validate({ paths: [] })).toThrow())
  it("rejects paths outside home", () =>
    expect(() => a.validate({ paths: ["/etc/passwd"] })).toThrow(/must start with "~\/"/))
  it("rejects .. traversal", () =>
    expect(() => a.validate({ paths: ["~/Documents/../.ssh/id_rsa"] })).toThrow(/\.\./))
  it("rejects sensitive home prefixes case-insensitively", () => {
    expect(() => a.validate({ paths: ["~/.ssh/known_hosts"] })).toThrow(/denied/)
    expect(() => a.validate({ paths: ["~/.SSH/id_rsa"] })).toThrow(/denied/)
  })
  it("rejects paths outside the allowlisted home roots", () => {
    expect(() => a.validate({ paths: ["~/.config/**"] })).toThrow(/denied|allowed home root/)
    expect(() => a.validate({ paths: ["~/Secrets/**"] })).toThrow(/allowed home root/)
  })
  it("accepts allowlisted roots case-insensitively", () => {
    expect(() => a.validate({ paths: ["~/documents/**"] })).not.toThrow()
  })
  it("rejects mid-path wildcards", () =>
    expect(() => a.validate({ paths: ["~/Doc*/**"] })).toThrow())
  it("accepts recursive and extension globs", () => {
    expect(() => a.validate({ paths: ["~/Downloads/**"] })).not.toThrow()
    expect(() => a.validate({ paths: ["~/Downloads/*.pdf"] })).not.toThrow()
    expect(() => a.validate({ paths: ["~/Documents/report.pdf"] })).not.toThrow()
  })
})

describe("contains", () => {
  const scope = a.canonicalize({ paths: ["~/Downloads/**", "~/Documents/report.pdf"] })
  const downloadsRoot = rootIdForPattern("~/Downloads/**")
  const reportRoot = rootIdForPattern("~/Documents/report.pdf")

  it("matches nested download paths", () =>
    expect(a.contains(scope, { rootId: downloadsRoot, relativePath: "inbox/receipt.pdf" })).toBe(
      true
    ))

  it("rejects traversal in requested relative path", () =>
    expect(a.contains(scope, { rootId: downloadsRoot, relativePath: "../.ssh/id_rsa" })).toBe(
      false
    ))

  it("matches an exact declared file", () =>
    expect(a.contains(scope, { rootId: reportRoot, relativePath: "report.pdf" })).toBe(true))

  it("rejects a sibling file outside the exact pattern", () =>
    expect(a.contains(scope, { rootId: reportRoot, relativePath: "other.pdf" })).toBe(false))

  it("matches extension globs case-insensitively", () => {
    const scope = a.canonicalize({ paths: ["~/Downloads/*.pdf"] })
    const rootId = rootIdForPattern("~/Downloads/*.pdf")
    expect(a.contains(scope, { rootId, relativePath: "REPORT.PDF" })).toBe(true)
  })
})

describe("resolveAbsolutePath", () => {
  it("joins under the declared directory root", () => {
    expect(resolveAbsolutePath(HOME, "~/Downloads/**", "a/b.txt")).toBe(
      "/home/alice/Downloads/a/b.txt"
    )
  })

  it("resolves an exact file pattern", () => {
    expect(resolveAbsolutePath(HOME, "~/Documents/report.pdf", "report.pdf")).toBe(
      "/home/alice/Documents/report.pdf"
    )
  })
})

describe("expandHomePath", () => {
  it("expands ~/Downloads/** to the downloads directory", () => {
    expect(expandHomePath("~/Downloads/**", HOME)).toBe("/home/alice/Downloads")
  })
})

describe("rootIdForPattern", () => {
  it("is stable for the same pattern", () => {
    expect(rootIdForPattern("~/Downloads/**")).toBe(rootIdForPattern("~/Downloads/**"))
  })
})

describe("validateSettle", () => {
  it("accepts stableMs at or above the floor", () => {
    expect(() => validateSettle({ stableMs: 1000 })).not.toThrow()
  })

  it("rejects too-small stableMs and non-array ignoreExtensions", () => {
    expect(() => validateSettle({ stableMs: 999 })).toThrow(/stableMs/)
    expect(() => validateSettle({ stableMs: 1000, ignoreExtensions: "tmp" })).toThrow(
      /ignoreExtensions/
    )
  })
})
