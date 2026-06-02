import { createWriteStream } from "node:fs"
import * as path from "node:path"
import { ZipFile } from "yazl"

export interface PackageFile {
  /** Absolute path on disk. */
  absPath: string
  /** Forward-slash path inside the `.deskit` archive. */
  archivePath: string
}

/**
 * Write the given files into a `.deskit` ZIP at `outPath`. Archive paths are
 * normalized to forward slashes so the package extracts identically on every
 * OS — the host's extractor validates entry paths and rejects backslashes.
 */
export function createDeskitPackage(files: PackageFile[], outPath: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const zip = new ZipFile()
    const output = createWriteStream(outPath)

    output.on("close", resolve)
    output.on("error", reject)
    zip.outputStream.on("error", reject)

    zip.outputStream.pipe(output)

    for (const file of files) {
      zip.addFile(file.absPath, toArchivePath(file.archivePath))
    }
    zip.end()
  })
}

function toArchivePath(archivePath: string): string {
  return archivePath.split(path.sep).join("/").replace(/^\/+/, "")
}
