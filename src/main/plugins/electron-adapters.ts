import type { ClipboardContent } from "@deskit/plugin-sdk"
import type { CaptureScreenOptions, PluginBridgeAdapters } from "./plugin-bridge"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { clipboard, desktopCapturer, nativeImage, Notification, shell } from "electron"

export function createElectronPluginAdapters(userDataDir: string): PluginBridgeAdapters {
  return {
    clipboard: {
      read: async () => readClipboardContent(),
      write: async (content) => writeClipboardContent(content),
    },
    notifications: {
      show: async (options) => {
        new Notification(options).show()
      },
    },
    system: {
      openUrl: async (url) => {
        const parsed = new URL(url)
        if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
          throw new Error("Only http(s) URLs can be opened by plugins")
        }
        await shell.openExternal(url)
      },
      openPath: async (targetPath) => {
        const error = await shell.openPath(targetPath)
        if (error) throw new Error(error)
      },
      captureScreen: async (pluginId, options) => captureScreen(userDataDir, pluginId, options),
    },
  }
}

async function readClipboardContent(): Promise<ClipboardContent | undefined> {
  const text = clipboard.readText()
  if (text) return { type: "text", text }

  const image = clipboard.readImage()
  if (!image.isEmpty()) {
    const size = image.getSize()
    return {
      type: "image",
      dataUrl: image.toDataURL(),
      mimeType: "image/png",
      width: size.width,
      height: size.height,
    }
  }

  return undefined
}

function writeClipboardContent(content: ClipboardContent): void {
  if (content.type === "text") {
    clipboard.writeText(content.text)
    return
  }
  if (content.type === "image") {
    clipboard.writeImage(nativeImage.createFromDataURL(content.dataUrl))
    return
  }
  // Electron does not expose a portable file-list clipboard writer. Keep the
  // file paths available to paste targets that accept plain text, while the
  // contract still preserves the richer file-list shape for history plugins.
  clipboard.writeText(content.paths.join("\n"))
}

async function captureScreen(
  userDataDir: string,
  pluginId: string,
  options?: CaptureScreenOptions
): Promise<{ path: string }> {
  const sources = await desktopCapturer.getSources({
    types: ["screen"],
    thumbnailSize: { width: 1920, height: 1080 },
  })
  const source = sources[0]
  if (!source) throw new Error("No screen source available")

  const fileName = `${safeFileName(options?.name ?? new Date().toISOString())}.png`
  const dir = path.join(userDataDir, "plugin-data", safeFileName(pluginId), "captures")
  await fs.mkdir(dir, { recursive: true })
  const filePath = path.join(dir, fileName)
  await fs.writeFile(filePath, source.thumbnail.toPNG())
  return { path: filePath }
}

function safeFileName(value: string): string {
  return value.replace(/[^\w.-]/g, "_")
}
