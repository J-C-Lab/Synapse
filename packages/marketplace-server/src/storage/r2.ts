import type { Buffer } from "node:buffer"
import type { StorageProvider, StoredObject } from "./types"
import { GetObjectCommand, PutObjectCommand, S3Client } from "@aws-sdk/client-s3"
import { getSignedUrl } from "@aws-sdk/s3-request-presigner"

export interface R2Options {
  endpoint: string
  bucket: string
  accessKeyId: string
  secretAccessKey: string
}

/**
 * Cloudflare R2 object storage via the S3-compatible API. The bucket is
 * private; downloads are served through short-lived presigned GET URLs, so the
 * stored `url` is a canonical reference, not a publicly fetchable link.
 */
export class R2StorageProvider implements StorageProvider {
  private readonly client: S3Client
  private readonly bucket: string
  private readonly endpoint: string

  constructor(options: R2Options) {
    this.bucket = options.bucket
    this.endpoint = options.endpoint.replace(/\/+$/, "")
    this.client = new S3Client({
      region: "auto",
      endpoint: options.endpoint,
      forcePathStyle: true,
      credentials: {
        accessKeyId: options.accessKeyId,
        secretAccessKey: options.secretAccessKey,
      },
    })
  }

  async put(key: string, body: Buffer, contentType: string): Promise<StoredObject> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: contentType,
      })
    )
    return { url: `${this.endpoint}/${this.bucket}/${key}` }
  }

  async signedDownloadUrl(key: string, ttlSeconds = 300): Promise<string> {
    return getSignedUrl(this.client, new GetObjectCommand({ Bucket: this.bucket, Key: key }), {
      expiresIn: ttlSeconds,
    })
  }
}
