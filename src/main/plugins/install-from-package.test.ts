import { Buffer } from "node:buffer"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { extractSynapsePackage } from "./install-from-package"

let dir: string

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "synapse-package-"))
})

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

describe("install-from-package", () => {
  it("extracts a valid .syn package into a destination directory", async () => {
    const packagePath = path.resolve(
      "resources",
      "mock-marketplace",
      "packages",
      "com.synapse.timestamp-0.3.0.syn"
    )
    const destination = path.join(dir, "extracted")

    await extractSynapsePackage(packagePath, destination)

    await expect(fs.readFile(path.join(destination, "synapse.json"), "utf-8")).resolves.toContain(
      '"com.synapse.timestamp"'
    )
    await expect(fs.stat(path.join(destination, "dist", "index.js"))).resolves.toBeTruthy()
  })

  it("rejects entries that escape the destination directory", async () => {
    const packagePath = path.join(dir, "escape.syn")
    await createZipPackage(packagePath, {
      "../escape.txt": "boom",
    })

    await expect(extractSynapsePackage(packagePath, path.join(dir, "out"))).rejects.toThrow(
      /Unsafe package entry path|invalid relative path/
    )
  })
})

async function createZipPackage(
  targetPath: string,
  entries: Record<string, string>
): Promise<void> {
  const localParts: Buffer[] = []
  const centralParts: Buffer[] = []
  let offset = 0

  for (const [name, content] of Object.entries(entries)) {
    const nameBuffer = Buffer.from(name)
    const contentBuffer = Buffer.from(content)
    const crc = crc32(contentBuffer)

    const localHeader = Buffer.alloc(30)
    localHeader.writeUInt32LE(0x04034b50, 0)
    localHeader.writeUInt16LE(20, 4)
    localHeader.writeUInt16LE(0, 6)
    localHeader.writeUInt16LE(0, 8)
    localHeader.writeUInt16LE(0, 10)
    localHeader.writeUInt16LE(0, 12)
    localHeader.writeUInt32LE(crc, 14)
    localHeader.writeUInt32LE(contentBuffer.length, 18)
    localHeader.writeUInt32LE(contentBuffer.length, 22)
    localHeader.writeUInt16LE(nameBuffer.length, 26)
    localHeader.writeUInt16LE(0, 28)

    localParts.push(localHeader, nameBuffer, contentBuffer)

    const centralHeader = Buffer.alloc(46)
    centralHeader.writeUInt32LE(0x02014b50, 0)
    centralHeader.writeUInt16LE(20, 4)
    centralHeader.writeUInt16LE(20, 6)
    centralHeader.writeUInt16LE(0, 8)
    centralHeader.writeUInt16LE(0, 10)
    centralHeader.writeUInt16LE(0, 12)
    centralHeader.writeUInt16LE(0, 14)
    centralHeader.writeUInt32LE(crc, 16)
    centralHeader.writeUInt32LE(contentBuffer.length, 20)
    centralHeader.writeUInt32LE(contentBuffer.length, 24)
    centralHeader.writeUInt16LE(nameBuffer.length, 28)
    centralHeader.writeUInt16LE(0, 30)
    centralHeader.writeUInt16LE(0, 32)
    centralHeader.writeUInt16LE(0, 34)
    centralHeader.writeUInt16LE(0, 36)
    centralHeader.writeUInt32LE(0, 38)
    centralHeader.writeUInt32LE(offset, 42)
    centralParts.push(centralHeader, nameBuffer)

    offset += localHeader.length + nameBuffer.length + contentBuffer.length
  }

  const centralDirectory = Buffer.concat(centralParts)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(Object.keys(entries).length, 8)
  end.writeUInt16LE(Object.keys(entries).length, 10)
  end.writeUInt32LE(centralDirectory.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  await fs.writeFile(targetPath, Buffer.concat([...localParts, centralDirectory, end]))
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff
  for (const byte of buffer) {
    crc ^= byte
    for (let bit = 0; bit < 8; bit += 1) {
      crc = crc & 1 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1
    }
  }
  return (crc ^ 0xffffffff) >>> 0
}
