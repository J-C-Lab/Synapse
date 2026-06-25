import type { WebContents } from "electron"

/**
 * Deny-safe cleanup when a renderer reloads or dies. The first main-frame
 * cross-document navigation is the initial load; later ones are reloads
 * (Cmd+R, Vite HMR). Same-document navigations (hash routing in App.tsx) and
 * sub-frame navigations are ignored. `render-process-gone` and `destroyed`
 * cover crashes and torn-down webContents.
 */
export function attachCapabilityPromptLifecycle(
  webContents: WebContents,
  onStale: () => void
): void {
  let hasLoadedMainDocument = false

  const stale = (): void => {
    onStale()
  }

  // Read the named fields off the event object. Electron's positional args for
  // this event are (event, url, isInPlace, isMainFrame, frameProcessId,
  // frameRoutingId) — there is no positional `isSameDocument`; the same-document
  // flag is carried as `details.isSameDocument` on the event itself.
  webContents.on("did-start-navigation", (details) => {
    if (!details.isMainFrame || details.isSameDocument) return

    if (hasLoadedMainDocument) stale()
    hasLoadedMainDocument = true
  })

  webContents.on("render-process-gone", stale)
  webContents.on("destroyed", stale)
}
