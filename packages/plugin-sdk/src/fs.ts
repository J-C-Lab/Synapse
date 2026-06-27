/** Safe fs.watch trigger event — root-relative, no absolute paths. */
export interface FsWatchEvent {
  rootId: string
  relativePath: string
  kind: "create" | "modify" | "delete" | "rename"
  timestamp: number
  size?: number
  ext?: string
}

export interface FsAPI {
  /** Resolve a declared root + relative path to an absolute path (gated). */
  resolvePath: (rootId: string, relativePath: string) => Promise<string>
  /** Read UTF-8 text from a declared root-relative path (gated). */
  readText: (rootId: string, relativePath: string) => Promise<string>
}
