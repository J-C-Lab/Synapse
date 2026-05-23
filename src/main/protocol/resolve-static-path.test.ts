import * as path from "node:path"
import { describe, expect, it } from "vitest"
import { getContentType, resolveStaticPath } from "./resolve-static-path"

const ROOT = path.resolve("/app/out/renderer")

describe("resolveStaticPath", () => {
  it("rewrites root to /index.html", () => {
    const result = resolveStaticPath("/", ROOT)
    expect(result).toEqual({ kind: "ok", filePath: path.join(ROOT, "index.html") })
  })

  it("rewrites empty pathname to /index.html", () => {
    const result = resolveStaticPath("", ROOT)
    expect(result).toEqual({ kind: "ok", filePath: path.join(ROOT, "index.html") })
  })

  it("resolves nested asset paths under root", () => {
    const result = resolveStaticPath("/assets/index-abc123.js", ROOT)
    expect(result).toEqual({
      kind: "ok",
      filePath: path.join(ROOT, "assets", "index-abc123.js"),
    })
  })

  it("decodes percent-encoded characters in the pathname", () => {
    const result = resolveStaticPath("/foo%20bar.txt", ROOT)
    expect(result).toEqual({ kind: "ok", filePath: path.join(ROOT, "foo bar.txt") })
  })

  it("rejects parent-directory traversal via ..", () => {
    const result = resolveStaticPath("/../etc/passwd", ROOT)
    expect(result).toEqual({ kind: "forbidden" })
  })

  it("rejects encoded parent-directory traversal", () => {
    const result = resolveStaticPath("/%2e%2e/secret.json", ROOT)
    expect(result).toEqual({ kind: "forbidden" })
  })

  it("rejects malformed percent-encoding", () => {
    const result = resolveStaticPath("/%E0%A4%A", ROOT)
    expect(result).toEqual({ kind: "forbidden" })
  })

  it("allows the root directory itself", () => {
    const result = resolveStaticPath("/", ROOT)
    expect(result.kind).toBe("ok")
  })
})

describe("getContentType", () => {
  it.each([
    ["index.html", "text/html; charset=utf-8"],
    ["chunk.js", "application/javascript; charset=utf-8"],
    ["chunk.mjs", "application/javascript; charset=utf-8"],
    ["styles.css", "text/css; charset=utf-8"],
    ["data.json", "application/json; charset=utf-8"],
    ["icon.svg", "image/svg+xml"],
    ["logo.png", "image/png"],
    ["font.woff2", "font/woff2"],
    ["icon.ico", "image/x-icon"],
    ["module.wasm", "application/wasm"],
  ])("maps %s to %s", (file, expected) => {
    expect(getContentType(file)).toBe(expected)
  })

  it("falls back to octet-stream for unknown extensions", () => {
    expect(getContentType("blob.xyz")).toBe("application/octet-stream")
  })

  it("matches the extension case-insensitively", () => {
    expect(getContentType("PHOTO.JPEG")).toBe("image/jpeg")
  })
})
