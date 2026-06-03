import { Buffer } from "node:buffer"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { IncomingTransferStore, OutgoingTransferStore, sha256Buffer } from "./transfer-store"

describe("incomingTransferStore", () => {
  let dir: string

  beforeEach(async () => {
    dir = await fs.mkdtemp(path.join(os.tmpdir(), "deskit-lan-transfer-"))
  })

  afterEach(async () => {
    await fs.rm(dir, { recursive: true, force: true })
  })

  it("reports missing chunks, assembles a verified file, and waits for confirmation", async () => {
    const store = new IncomingTransferStore(dir)
    await store.init()
    const chunks = [Buffer.from("abc"), Buffer.from("def"), Buffer.from("ghi")]
    const file = Buffer.concat(chunks)
    const request = {
      id: "transfer",
      deviceId: "sender",
      deviceName: "Sender",
      fileName: "../safe.txt",
      size: file.length,
      sha256: sha256Buffer(file),
      chunkSize: 3,
    }
    await store.create(request)
    await store.putChunk("transfer", 0, chunks[0], sha256Buffer(chunks[0]))
    await store.putChunk("transfer", 2, chunks[2], sha256Buffer(chunks[2]))

    await expect(store.create(request)).resolves.toMatchObject({ missingChunks: [1] })
    await store.putChunk("transfer", 1, chunks[1], sha256Buffer(chunks[1]))
    await expect(store.complete("transfer")).resolves.toMatchObject({
      fileName: "safe.txt",
      state: "awaiting-confirmation",
    })

    const destination = path.join(dir, "received.txt")
    await store.accept("transfer", destination)
    await expect(fs.readFile(destination, "utf-8")).resolves.toBe("abcdefghi")

    await store.remove("transfer")
    expect(store.list()).toEqual([])
    await expect(fs.readFile(destination, "utf-8")).resolves.toBe("abcdefghi")
  })

  it("persists removed outgoing transfer history", async () => {
    const filePath = path.join(dir, "outgoing.json")
    const sourcePath = path.join(dir, "source.txt")
    await fs.writeFile(sourcePath, "payload")
    const store = new OutgoingTransferStore(filePath)
    await store.init()
    const transfer = await store.create("peer", "Peer", sourcePath)
    await store.update(transfer.id, { state: "completed" })

    await store.remove(transfer.id)

    const restored = new OutgoingTransferStore(filePath)
    await restored.init()
    expect(restored.list()).toEqual([])
  })
})
