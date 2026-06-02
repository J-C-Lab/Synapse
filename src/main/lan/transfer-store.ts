import type { LanTransfer } from "./types"
import { Buffer } from "node:buffer"
import { createHash, randomUUID } from "node:crypto"
import { once } from "node:events"
import { createReadStream, createWriteStream, promises as fs } from "node:fs"
import * as path from "node:path"
import { readJsonFile, writeJsonFile } from "./atomic-json-store"

export const LAN_CHUNK_SIZE = 1024 * 1024

interface IncomingTransferMetadata extends LanTransfer {
  receivedChunks: number[]
}

interface OutgoingTransferMetadata extends LanTransfer {
  sourcePath: string
}

export interface IncomingTransferRequest {
  id: string
  deviceId: string
  deviceName: string
  fileName: string
  size: number
  sha256: string
  chunkSize: number
}

export interface IncomingTransferStatus {
  transfer: LanTransfer
  missingChunks: number[]
}

export class IncomingTransferStore {
  private readonly transfers = new Map<string, IncomingTransferMetadata>()

  constructor(private readonly rootDir: string) {}

  async init(): Promise<void> {
    await fs.mkdir(this.rootDir, { recursive: true })
    for (const name of await fs.readdir(this.rootDir)) {
      const metadata = normalizeIncoming(await readJsonFile(this.metadataPath(name)))
      if (metadata) this.transfers.set(metadata.id, metadata)
    }
  }

  async create(request: IncomingTransferRequest): Promise<IncomingTransferStatus> {
    const existing = this.transfers.get(request.id)
    if (existing) {
      assertSameTransfer(existing, request)
      return this.status(existing)
    }
    const transfer: IncomingTransferMetadata = {
      ...request,
      fileName: safeFileName(request.fileName),
      direction: "incoming",
      state: "transferring",
      completedChunks: 0,
      totalChunks: chunkCount(request.size, request.chunkSize),
      transferredBytes: 0,
      receivedChunks: [],
    }
    await fs.mkdir(this.chunkDir(transfer.id), { recursive: true })
    await this.save(transfer)
    this.transfers.set(transfer.id, transfer)
    return this.status(transfer)
  }

  async putChunk(id: string, index: number, chunk: Buffer, sha256: string): Promise<LanTransfer> {
    const transfer = this.require(id)
    assertChunkIndex(transfer, index)
    if (chunk.length !== chunkSizeAt(transfer, index)) throw new Error("Chunk size is invalid.")
    if (sha256Buffer(chunk) !== sha256) throw new Error("Chunk SHA-256 does not match.")
    if (!transfer.receivedChunks.includes(index)) {
      await fs.writeFile(this.chunkPath(id, index), chunk)
      transfer.receivedChunks.push(index)
      transfer.receivedChunks.sort((left, right) => left - right)
      transfer.completedChunks = transfer.receivedChunks.length
      transfer.transferredBytes = transfer.receivedChunks.reduce(
        (total, current) => total + chunkSizeAt(transfer, current),
        0
      )
      await this.save(transfer)
    }
    return toPublicTransfer(transfer)
  }

  async complete(id: string): Promise<LanTransfer> {
    const transfer = this.require(id)
    const missingChunks = missingChunkIndexes(transfer)
    if (missingChunks.length > 0) throw new Error("Transfer still has missing chunks.")
    const assembledPath = this.assembledPath(id)
    const output = createWriteStream(assembledPath)
    for (let index = 0; index < transfer.totalChunks; index += 1) {
      for await (const chunk of createReadStream(this.chunkPath(id, index))) {
        if (!output.write(chunk)) await once(output, "drain")
      }
    }
    output.end()
    await once(output, "finish")
    if ((await sha256File(assembledPath)) !== transfer.sha256) {
      await fs.rm(assembledPath, { force: true })
      throw new Error("Completed file SHA-256 does not match.")
    }
    transfer.state = "awaiting-confirmation"
    await this.save(transfer)
    return toPublicTransfer(transfer)
  }

  async accept(id: string, destinationPath: string): Promise<LanTransfer> {
    const transfer = this.require(id)
    if (transfer.state !== "awaiting-confirmation") {
      throw new Error("Transfer is not awaiting confirmation.")
    }
    await fs.mkdir(path.dirname(destinationPath), { recursive: true })
    await moveFile(this.assembledPath(id), destinationPath)
    transfer.state = "completed"
    await this.save(transfer)
    return toPublicTransfer(transfer)
  }

  async reject(id: string): Promise<LanTransfer> {
    const transfer = this.require(id)
    transfer.state = "rejected"
    await fs.rm(this.transferDir(id), { recursive: true, force: true })
    this.transfers.delete(id)
    return toPublicTransfer(transfer)
  }

  async remove(id: string): Promise<void> {
    this.require(id)
    await fs.rm(this.transferDir(id), { recursive: true, force: true })
    this.transfers.delete(id)
  }

  list(): LanTransfer[] {
    return [...this.transfers.values()].map(toPublicTransfer)
  }

  get(id: string): LanTransfer | null {
    const transfer = this.transfers.get(id)
    return transfer ? toPublicTransfer(transfer) : null
  }

  private require(id: string): IncomingTransferMetadata {
    const transfer = this.transfers.get(id)
    if (!transfer) throw new Error("Transfer was not found.")
    return transfer
  }

  private status(transfer: IncomingTransferMetadata): IncomingTransferStatus {
    return {
      transfer: toPublicTransfer(transfer),
      missingChunks: missingChunkIndexes(transfer),
    }
  }

  private async save(transfer: IncomingTransferMetadata): Promise<void> {
    await writeJsonFile(this.metadataPath(transfer.id), transfer)
  }

  private transferDir(id: string): string {
    return path.join(this.rootDir, id)
  }

  private chunkDir(id: string): string {
    return path.join(this.transferDir(id), "chunks")
  }

  private chunkPath(id: string, index: number): string {
    return path.join(this.chunkDir(id), `${index}.part`)
  }

  private assembledPath(id: string): string {
    return path.join(this.transferDir(id), "assembled.part")
  }

  private metadataPath(id: string): string {
    return path.join(this.transferDir(id), "metadata.json")
  }
}

export class OutgoingTransferStore {
  private readonly transfers = new Map<string, OutgoingTransferMetadata>()

  constructor(private readonly filePath: string) {}

  async init(): Promise<void> {
    const raw = await readJsonFile(this.filePath)
    if (!Array.isArray(raw)) return
    for (const value of raw) {
      const transfer = normalizeOutgoing(value)
      if (transfer) this.transfers.set(transfer.id, transfer)
    }
  }

  async create(deviceId: string, deviceName: string, sourcePath: string): Promise<LanTransfer> {
    const stats = await fs.stat(sourcePath)
    if (!stats.isFile()) throw new Error("Selected path is not a file.")
    const metadata: OutgoingTransferMetadata = {
      id: randomUUID(),
      direction: "outgoing",
      deviceId,
      deviceName,
      sourcePath,
      fileName: path.basename(sourcePath),
      size: stats.size,
      sha256: await sha256File(sourcePath),
      chunkSize: LAN_CHUNK_SIZE,
      completedChunks: 0,
      totalChunks: chunkCount(stats.size, LAN_CHUNK_SIZE),
      transferredBytes: 0,
      state: "preparing",
    }
    this.transfers.set(metadata.id, metadata)
    await this.save()
    return toPublicTransfer(metadata)
  }

  get(id: string): OutgoingTransferMetadata | null {
    return this.transfers.get(id) ?? null
  }

  list(): LanTransfer[] {
    return [...this.transfers.values()].map(toPublicTransfer)
  }

  async update(id: string, patch: Partial<LanTransfer>): Promise<LanTransfer> {
    const transfer = this.transfers.get(id)
    if (!transfer) throw new Error("Transfer was not found.")
    Object.assign(transfer, patch)
    await this.save()
    return toPublicTransfer(transfer)
  }

  async remove(id: string): Promise<void> {
    if (!this.transfers.delete(id)) throw new Error("Transfer was not found.")
    await this.save()
  }

  private async save(): Promise<void> {
    await writeJsonFile(this.filePath, [...this.transfers.values()])
  }
}

export async function readChunk(
  filePath: string,
  index: number,
  chunkSize: number
): Promise<Buffer> {
  const handle = await fs.open(filePath, "r")
  try {
    const buffer = Buffer.alloc(chunkSize)
    const { bytesRead } = await handle.read(buffer, 0, chunkSize, index * chunkSize)
    return buffer.subarray(0, bytesRead)
  } finally {
    await handle.close()
  }
}

export function sha256Buffer(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex")
}

export async function sha256File(filePath: string): Promise<string> {
  const hash = createHash("sha256")
  for await (const chunk of createReadStream(filePath)) hash.update(chunk as Buffer)
  return hash.digest("hex")
}

function missingChunkIndexes(transfer: IncomingTransferMetadata): number[] {
  const received = new Set(transfer.receivedChunks)
  return Array.from({ length: transfer.totalChunks }, (_, index) => index).filter(
    (index) => !received.has(index)
  )
}

function chunkCount(size: number, chunkSize: number): number {
  return Math.ceil(size / chunkSize)
}

function chunkSizeAt(
  transfer: Pick<LanTransfer, "chunkSize" | "size" | "totalChunks">,
  index: number
) {
  return index === transfer.totalChunks - 1
    ? transfer.size - index * transfer.chunkSize
    : transfer.chunkSize
}

function assertChunkIndex(transfer: LanTransfer, index: number): void {
  if (!Number.isInteger(index) || index < 0 || index >= transfer.totalChunks) {
    throw new Error("Chunk index is invalid.")
  }
}

function assertSameTransfer(existing: IncomingTransferMetadata, request: IncomingTransferRequest) {
  if (
    existing.deviceId !== request.deviceId ||
    existing.fileName !== safeFileName(request.fileName) ||
    existing.size !== request.size ||
    existing.sha256 !== request.sha256 ||
    existing.chunkSize !== request.chunkSize
  ) {
    throw new Error("Transfer metadata does not match the existing session.")
  }
}

function safeFileName(fileName: string): string {
  const safe = path.basename(fileName).trim()
  if (!safe || safe === "." || safe === "..") throw new Error("File name is invalid.")
  return safe
}

async function moveFile(sourcePath: string, destinationPath: string): Promise<void> {
  try {
    await fs.rename(sourcePath, destinationPath)
  } catch (err) {
    if (!err || typeof err !== "object" || (err as { code?: string }).code !== "EXDEV") throw err
    await fs.copyFile(sourcePath, destinationPath)
    await fs.rm(sourcePath, { force: true })
  }
}

function toPublicTransfer(
  transfer: LanTransfer & { receivedChunks?: number[]; sourcePath?: string }
): LanTransfer {
  const { receivedChunks: _receivedChunks, sourcePath: _sourcePath, ...publicTransfer } = transfer
  return publicTransfer
}

function normalizeIncoming(value: unknown): IncomingTransferMetadata | null {
  const transfer = normalizeTransfer(value)
  if (!transfer || transfer.direction !== "incoming" || !value || typeof value !== "object") {
    return null
  }
  const receivedChunks = (value as { receivedChunks?: unknown }).receivedChunks
  if (!Array.isArray(receivedChunks) || !receivedChunks.every(Number.isInteger)) return null
  return { ...transfer, receivedChunks: receivedChunks as number[] }
}

function normalizeOutgoing(value: unknown): OutgoingTransferMetadata | null {
  const transfer = normalizeTransfer(value)
  if (!transfer || transfer.direction !== "outgoing" || !value || typeof value !== "object") {
    return null
  }
  const sourcePath = (value as { sourcePath?: unknown }).sourcePath
  return typeof sourcePath === "string" ? { ...transfer, sourcePath } : null
}

function normalizeTransfer(value: unknown): LanTransfer | null {
  if (!value || typeof value !== "object") return null
  const transfer = value as Record<string, unknown>
  if (
    typeof transfer.id !== "string" ||
    (transfer.direction !== "incoming" && transfer.direction !== "outgoing") ||
    typeof transfer.deviceId !== "string" ||
    typeof transfer.deviceName !== "string" ||
    typeof transfer.fileName !== "string" ||
    typeof transfer.size !== "number" ||
    typeof transfer.sha256 !== "string" ||
    typeof transfer.chunkSize !== "number" ||
    typeof transfer.completedChunks !== "number" ||
    typeof transfer.totalChunks !== "number" ||
    typeof transfer.transferredBytes !== "number" ||
    typeof transfer.state !== "string"
  ) {
    return null
  }
  return transfer as unknown as LanTransfer
}
