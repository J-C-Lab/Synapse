import { resolve } from "node:path"

// Workspace-package + Electron-stub aliases shared by every Vitest config in
// this repo (vitest.config.ts, vitest.eval.config.ts, ...). Keep these in one
// place so a new alias only needs to be added once — each config picks the
// subset it actually needs from `resolve.alias`, not the whole object.
export const workspaceAliases = {
  "@synapse/plugin-sdk": resolve(__dirname, "packages/plugin-sdk/src/index.ts"),
  "@synapse/plugin-manifest": resolve(__dirname, "packages/plugin-manifest/src/index.ts"),
  "@synapse/plugin-cli": resolve(__dirname, "packages/plugin-cli/src/index.ts"),
  "@synapse/marketplace-types": resolve(__dirname, "packages/marketplace-types/src/index.ts"),
  // Stub Electron when running tests outside of the Electron runtime.
  electron: resolve(__dirname, "__mocks__/electron.ts"),
}
