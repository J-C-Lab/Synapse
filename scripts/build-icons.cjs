// One-shot icon generator. Regenerates every product icon from the master
// raster logo so a brand change is a single command:
//
//   pnpm icons
//
// Source:
//   resources/logo.png         (square master, e.g. 1024x1024)
//
// Outputs:
//   resources/icon.png         (512x512 — Linux app icon + electron-builder master)
//   resources/icon.ico         (Windows app icon, multi-size)
//   resources/icon.icns        (macOS app icon, multi-size)
//   resources/tray.png         (24x24, 1x DPI — tray base)
//   resources/tray@2x.png      (48x48, 2x DPI)
//   resources/tray@3x.png      (72x72, 3x DPI)
//   resources/notification.png (384x384 — Windows toast / Linux notify-send)
//
// Electron's nativeImage.createFromPath() automatically picks the @Nx tray
// variant matching the active display scale, so the tray stays crisp on HiDPI.

const fs = require("node:fs/promises")
const path = require("node:path")
const process = require("node:process")
const png2icons = require("png2icons")
const sharp = require("sharp")

const ROOT = path.resolve(__dirname, "..")
const RES = path.join(ROOT, "resources")
const SOURCE = path.join(RES, "logo.png")

// App icons keep the master's designed padding. Tray/notification marks are
// tiny, so trim the transparent border first and re-pad lightly so the glyph
// fills the frame and stays legible.
const APP_ICON_PNG = 512
const TRIMMED = [
  { size: 24, name: "tray.png" },
  { size: 48, name: "tray@2x.png" },
  { size: 72, name: "tray@3x.png" },
  { size: 384, name: "notification.png" },
]

async function writePng(buffer, size, name) {
  const out = path.join(RES, name)
  await fs.writeFile(out, buffer)
  console.log(`wrote ${path.relative(ROOT, out)} (${size}x${size}, ${buffer.byteLength} bytes)`)
}

async function main() {
  const master = await fs.readFile(SOURCE)

  // icon.png — Linux + electron-builder master (square, designed padding kept).
  const iconPng = await sharp(master)
    .resize(APP_ICON_PNG, APP_ICON_PNG, {
      fit: "contain",
      background: { r: 0, g: 0, b: 0, alpha: 0 },
    })
    .png()
    .toBuffer()
  await writePng(iconPng, APP_ICON_PNG, "icon.png")

  // icon.ico / icon.icns — derived by png2icons from the full-res master.
  const ico = png2icons.createICO(master, png2icons.BICUBIC, 0, false)
  if (!ico) throw new Error("png2icons failed to create icon.ico")
  await fs.writeFile(path.join(RES, "icon.ico"), ico)
  console.log(`wrote resources/icon.ico (${ico.byteLength} bytes)`)

  const icns = png2icons.createICNS(master, png2icons.BICUBIC, 0)
  if (!icns) throw new Error("png2icons failed to create icon.icns")
  await fs.writeFile(path.join(RES, "icon.icns"), icns)
  console.log(`wrote resources/icon.icns (${icns.byteLength} bytes)`)

  // Trim the transparent border once, then fit each small target with a small
  // transparent margin (~8% of the side) so the mark reads at tray sizes.
  const trimmed = await sharp(master).trim().png().toBuffer()
  for (const { size, name } of TRIMMED) {
    const margin = Math.round(size * 0.08)
    const buf = await sharp(trimmed)
      .resize(size - margin * 2, size - margin * 2, {
        fit: "contain",
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .extend({
        top: margin,
        bottom: margin,
        left: margin,
        right: margin,
        background: { r: 0, g: 0, b: 0, alpha: 0 },
      })
      .png()
      .toBuffer()
    await writePng(buf, size, name)
  }
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
