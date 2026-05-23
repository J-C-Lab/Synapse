// Global typings for the surface exposed by src/preload/index.ts.
// Kept in the preload package so the renderer and the preload always
// agree on the contract.

export {}

declare global {
  interface Window {
    electronAPI?: {
      greet: (name: string) => Promise<string>
    }
  }
}
