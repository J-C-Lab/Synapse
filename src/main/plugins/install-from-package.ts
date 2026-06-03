import { createWriteStream, promises as fs } from "node:fs"
import * as path from "node:path"
import { pipeline } from "node:stream/promises"
import * as yauzl from "yauzl"

export async function extractSynapsePackage(
  packagePath: string,
  destinationDir: string
): Promise<void> {
  await fs.mkdir(destinationDir, { recursive: true })
  const zipfile = await openZip(packagePath)

  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false
      const fail = (err: unknown): void => {
        if (settled) return
        settled = true
        reject(err)
      }
      const done = (): void => {
        if (settled) return
        settled = true
        resolve()
      }

      zipfile.on("error", fail)
      zipfile.on("end", done)
      zipfile.on("entry", (entry) => {
        void extractZipEntry(zipfile, entry, destinationDir)
          .then(() => zipfile.readEntry())
          .catch(fail)
      })
      zipfile.readEntry()
    })
  } finally {
    zipfile.close()
  }
}

function openZip(packagePath: string): Promise<yauzl.ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.open(
      packagePath,
      { lazyEntries: true, decodeStrings: true, validateEntrySizes: true },
      (err, zipfile) => {
        if (err) {
          reject(err)
          return
        }
        resolve(zipfile)
      }
    )
  })
}

async function extractZipEntry(
  zipfile: yauzl.ZipFile,
  entry: yauzl.Entry,
  destinationDir: string
): Promise<void> {
  const targetPath = resolveZipEntryPath(entry.fileName, destinationDir)
  if (entry.fileName.endsWith("/")) {
    await fs.mkdir(targetPath, { recursive: true })
    return
  }

  await fs.mkdir(path.dirname(targetPath), { recursive: true })
  const stream = await openReadStream(zipfile, entry)
  await pipeline(stream, createWriteStream(targetPath, { flags: "wx" }))
}

function openReadStream(zipfile: yauzl.ZipFile, entry: yauzl.Entry) {
  return new Promise<NodeJS.ReadableStream>((resolve, reject) => {
    zipfile.openReadStream(entry, (err, stream) => {
      if (err) {
        reject(err)
        return
      }
      resolve(stream)
    })
  })
}

function resolveZipEntryPath(entryName: string, destinationDir: string): string {
  const invalidReason = yauzl.validateFileName(entryName)
  if (invalidReason) {
    throw new Error(`Unsafe package entry path: ${entryName}`)
  }

  const normalized = entryName.replace(/\\/g, "/")
  if (!normalized || normalized.includes("\0") || normalized.startsWith("/")) {
    throw new Error(`Unsafe package entry path: ${entryName}`)
  }

  const parts = normalized.split("/").filter(Boolean)
  if (parts.length === 0 || parts.includes("..") || /^[a-z]:/i.test(parts[0] ?? "")) {
    throw new Error(`Unsafe package entry path: ${entryName}`)
  }

  const target = path.resolve(destinationDir, ...parts)
  if (!isInsideOrSameDirectory(target, path.resolve(destinationDir))) {
    throw new Error(`Unsafe package entry path: ${entryName}`)
  }
  return target
}

function isInsideOrSameDirectory(target: string, parent: string): boolean {
  const relative = path.relative(parent, target)
  return !relative || (!relative.startsWith("..") && !path.isAbsolute(relative))
}
