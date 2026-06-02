import { resolve } from "node:path"
import tailwindcss from "@tailwindcss/vite"
import react from "@vitejs/plugin-react"
import { defineConfig, externalizeDepsPlugin } from "electron-vite"

// electron-vite produces three independent bundles:
//   out/main/index.js        ← main process (Node, CommonJS)
//   out/preload/index.js     ← preload (sandboxed, CommonJS)
//   out/renderer/index.html  ← renderer (browser, ESM)
//
// In dev, the renderer is served at process.env.ELECTRON_RENDERER_URL
// (e.g. http://localhost:5173) and the main process loads that URL.
// In production, the main process loads the built renderer via the
// custom `app://` scheme registered in src/main/index.ts.

export default defineConfig({
  main: {
    // @deskit/plugin-manifest is a workspace package with runtime code (zod
    // schema). Bundle it from source instead of externalizing it so the app
    // needs no prior `pnpm build:manifest` in dev/build — mirrors how the SDK
    // is aliased to source for tsc/vitest. zod stays externalized (real dep).
    plugins: [externalizeDepsPlugin({ exclude: ["@deskit/plugin-manifest"] })],
    resolve: {
      alias: {
        "@deskit/plugin-manifest": resolve(__dirname, "packages/plugin-manifest/src/index.ts"),
        "@deskit/plugin-sdk": resolve(__dirname, "packages/plugin-sdk/src/index.ts"),
      },
    },
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/main/index.ts") },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    build: {
      rollupOptions: {
        input: { index: resolve(__dirname, "src/preload/index.ts") },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, "src/renderer"),
    resolve: {
      alias: {
        "@": resolve(__dirname, "src/renderer/src"),
        "@deskit/plugin-sdk": resolve(__dirname, "packages/plugin-sdk/src/index.ts"),
      },
    },
    plugins: [react(), tailwindcss()],
    build: {
      rollupOptions: {
        input: resolve(__dirname, "src/renderer/index.html"),
      },
    },
  },
})
