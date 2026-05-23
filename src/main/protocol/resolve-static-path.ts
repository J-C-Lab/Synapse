import * as path from "node:path"

export type ResolveResult = { kind: "ok"; filePath: string } | { kind: "forbidden" }

/**
 * Maps a URL pathname (e.g. "/assets/index-abc123.js") to an absolute
 * path inside `root`, with directory-traversal protection.
 *
 * Why: the static-asset handler must serve files relative to the renderer
 * output directory while rejecting any path that escapes that directory
 * via "..", encoded slashes, or absolute symlinks the URL constructor missed.
 */
export function resolveStaticPath(rawPathname: string, root: string): ResolveResult {
  let pathname: string
  try {
    pathname = decodeURIComponent(rawPathname)
  } catch {
    return { kind: "forbidden" }
  }

  if (pathname === "" || pathname === "/") {
    pathname = "/index.html"
  }

  const filePath = path.normalize(path.join(root, pathname))
  const normalizedRoot = path.normalize(root)
  const rootWithSep = normalizedRoot.endsWith(path.sep) ? normalizedRoot : normalizedRoot + path.sep

  if (filePath !== normalizedRoot && !filePath.startsWith(rootWithSep)) {
    return { kind: "forbidden" }
  }

  return { kind: "ok", filePath }
}

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".js": "application/javascript; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".eot": "application/vnd.ms-fontobject",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
}

export function getContentType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase()
  return CONTENT_TYPES[ext] ?? "application/octet-stream"
}
