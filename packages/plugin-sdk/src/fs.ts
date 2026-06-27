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
  /** Create a new file (fails if it exists). Gated by fs:write. */
  writeText: (rootId: string, relativePath: string, data: string) => Promise<void>
  /** Create a directory (idempotent). Gated by fs:write. */
  mkdir: (rootId: string, relativePath: string) => Promise<void>
  /** Move/rename a file; fails if the target exists. Gated by fs:write. */
  move: (
    fromRootId: string,
    fromRel: string,
    toRootId: string,
    toRel: string
  ) => Promise<{ journalId: string }>
}
