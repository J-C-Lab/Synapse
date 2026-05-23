// One-shot SVG -> PNG rasterizer for app icons.
//
// Run when `resources/logo.svg` changes. Uses the bundled Electron
// (already a devDep) as a headless Chromium so we don't need any extra
// rasterization dependency.
//
//   pnpm exec electron scripts/build-tray-icons.cjs
//
// Outputs:
//   resources/tray.png         (16x16, 1x DPI — tray base)
//   resources/tray@2x.png      (32x32, 2x DPI)
//   resources/tray@3x.png      (48x48, 3x DPI)
//   resources/notification.png (256x256 — Windows toast / Linux notify-send)
//
// Electron's nativeImage.createFromPath() automatically picks the @Nx
// variant matching the active display scale, so the tray stays crisp on
// HiDPI screens.

const { Buffer } = require("node:buffer")
const fs = require("node:fs/promises")
const path = require("node:path")
const { app, BrowserWindow } = require("electron")

const ROOT = path.resolve(__dirname, "..")
const SVG_PATH = path.join(ROOT, "resources", "logo.svg")
const SIZES = [
  { scale: 1, size: 16, name: "tray.png" },
  { scale: 2, size: 32, name: "tray@2x.png" },
  { scale: 3, size: 48, name: "tray@3x.png" },
  { scale: 1, size: 256, name: "notification.png" },
]

async function rasterize(win, svg, size) {
  // Strip width/height so the inline SVG fills the container at the
  // requested pixel size; keep the viewBox for proper scaling.
  const sized = svg.replace(/\swidth="[^"]+"/i, "").replace(/\sheight="[^"]+"/i, "")

  const html = `<!doctype html><html><head><style>
    html,body{margin:0;padding:0;background:transparent;width:${size}px;height:${size}px;overflow:hidden}
    svg{width:${size}px;height:${size}px;display:block}
  </style></head><body>${sized}</body></html>`

  win.setContentSize(size, size)
  await win.loadURL(`data:text/html;base64,${Buffer.from(html).toString("base64")}`)
  // One paint tick is usually enough, but give the renderer a beat
  // so the SVG path geometry settles before capture.
  await new Promise((r) => setTimeout(r, 120))
  const image = await win.webContents.capturePage()
  return image.toPNG()
}

async function main() {
  await app.whenReady()
  const svg = await fs.readFile(SVG_PATH, "utf-8")

  // Reuse one BrowserWindow across all sizes — destroying and recreating
  // mid-tick on first launch occasionally fires ERR_FAILED on the second
  // loadURL. setContentSize + loadURL is rock-solid.
  const win = new BrowserWindow({
    width: 256,
    height: 256,
    show: false,
    frame: false,
    transparent: true,
    useContentSize: true,
    webPreferences: { offscreen: false },
  })

  try {
    for (const { size, name } of SIZES) {
      const png = await rasterize(win, svg, size)
      const out = path.join(ROOT, "resources", name)
      await fs.writeFile(out, png)
      console.log(`wrote ${path.relative(ROOT, out)} (${size}x${size}, ${png.byteLength} bytes)`)
    }
  } finally {
    win.destroy()
  }

  app.quit()
}

main().catch((err) => {
  console.error(err)
  app.exit(1)
})
