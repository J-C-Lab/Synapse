import { nativeTheme } from "electron"

export interface TitleBarOverlayColors {
  color: string
  symbolColor: string
  height: number
}

/** "system" resolves through Electron's OS-level preference, mirroring the
 *  renderer's own matchMedia("prefers-color-scheme: dark") resolution in
 *  use-theme.tsx — the two must never disagree about which scheme is active. */
export function resolveTitleBarScheme(themeMode: "light" | "dark" | "system"): "light" | "dark" {
  if (themeMode === "system") return nativeTheme.shouldUseDarkColors ? "dark" : "light"
  return themeMode
}

/** Colors match globals.css's --background/--foreground oklch tokens exactly
 *  (oklch(1 0 0)/oklch(0.145 0 0) light, oklch(0.145 0 0)/oklch(0.985 0 0)
 *  dark) so the native window-control overlay never clashes with whichever
 *  scheme the renderer actually painted. */
export function titleBarOverlayForScheme(scheme: "light" | "dark"): TitleBarOverlayColors {
  return scheme === "dark"
    ? { color: "#0a0a0a", symbolColor: "#fafafa", height: 48 }
    : { color: "#ffffff", symbolColor: "#0a0a0a", height: 48 }
}

function blendHex(hex: string, target: [number, number, number], amount: number): string {
  const r = Number.parseInt(hex.slice(1, 3), 16)
  const g = Number.parseInt(hex.slice(3, 5), 16)
  const b = Number.parseInt(hex.slice(5, 7), 16)
  const mix = (channel: number, targetChannel: number) =>
    Math.round(channel + (targetChannel - channel) * amount)
  const toHex = (value: number) => value.toString(16).padStart(2, "0")
  return `#${toHex(mix(r, target[0]))}${toHex(mix(g, target[1]))}${toHex(mix(b, target[2]))}`
}

/**
 * Native title-bar-overlay buttons (min/maximize/close) are drawn by Windows
 * as a layer above the whole renderer, entirely outside the web content's
 * stacking context — so a modal dialog's backdrop dimming the page never
 * touches them, and they read as a bright, out-of-place rectangle floating
 * over the dimmed content. Blending the overlay's colors toward the same
 * dimming the dialog backdrop applies approximates that look, since
 * `setTitleBarOverlay` only accepts opaque colors (no real alpha blending
 * against the content behind it).
 */
export function dimTitleBarOverlay(overlay: TitleBarOverlayColors): TitleBarOverlayColors {
  return {
    color: blendHex(overlay.color, [0, 0, 0], 0.55),
    symbolColor: blendHex(overlay.symbolColor, [128, 128, 128], 0.35),
    height: overlay.height,
  }
}
