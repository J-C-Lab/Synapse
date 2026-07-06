import { existsSync } from "node:fs"
import * as path from "node:path"

let cached: string | undefined

/** Walk from a bundle dir (main entry or lazy chunk) to `out/main`. */
export function resolveMainOutputDir(
  startDir: string,
  exists: (filePath: string) => boolean = existsSync
): string {
  let dir = startDir
  for (let depth = 0; depth < 5; depth++) {
    if (exists(path.join(dir, "index.js"))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return path.join(startDir, "..")
}

/** Directory containing `out/main/index.js` (works from main entry or lazy chunks). */
export function getMainOutputDir(): string {
  if (cached) return cached
  cached = resolveMainOutputDir(__dirname)
  return cached
}
