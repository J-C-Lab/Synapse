import { app } from "electron"

// `app.getFileIcon` reads from disk on every call — cache by path for the
// life of the process since a shortcut's icon never changes mid-session.
const cache = new Map<string, string | undefined>()

/** Resolves a Start-menu/.app icon to a data URL, or undefined if unavailable. */
export async function resolveAppIcon(iconPath: string | undefined): Promise<string | undefined> {
  if (!iconPath) return undefined
  if (cache.has(iconPath)) return cache.get(iconPath)

  let dataUrl: string | undefined
  try {
    const image = await app.getFileIcon(iconPath, { size: "normal" })
    dataUrl = image.isEmpty() ? undefined : image.toDataURL()
  } catch {
    dataUrl = undefined
  }
  cache.set(iconPath, dataUrl)
  return dataUrl
}
