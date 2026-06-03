/**
 * Clipboard payloads supported by the Synapse host.
 *
 * The shape is intentionally JSON-serialisable so clipboard-history plugins
 * can persist entries in `StorageAPI` without special codecs. Host
 * implementations may choose to store large image payloads outside the JSON
 * file and return a `dataUrl` or host-managed path in later stages, but the
 * plugin contract stays content-type based.
 */
export type ClipboardContent = ClipboardTextContent | ClipboardImageContent | ClipboardFileContent

export interface ClipboardTextContent {
  type: "text"
  text: string
}

export interface ClipboardImageContent {
  type: "image"
  /** PNG/JPEG/WebP data URL produced by the host from the OS clipboard. */
  dataUrl: string
  mimeType: "image/png" | "image/jpeg" | "image/webp" | string
  width?: number
  height?: number
  name?: string
}

export interface ClipboardFileContent {
  type: "file"
  /** One or more absolute file paths currently present on the OS clipboard. */
  paths: string[]
}

export type ClipboardActionValue = string | ClipboardContent
