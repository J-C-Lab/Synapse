import { useEffect, useState } from "react"

const SCROLL_LOCK_CLASS_PREFIX = "block-interactivity-"

function hasScrollLockClass(): boolean {
  return Array.from(document.body.classList).some((cls) => cls.startsWith(SCROLL_LOCK_CLASS_PREFIX))
}

/**
 * True whenever at least one Radix modal (Dialog, AlertDialog, Sheet, ...) is
 * open. `react-remove-scroll` — used internally by every Radix primitive
 * that locks body scroll while open — stamps a `block-interactivity-<id>`
 * class onto `document.body` for the duration, which is the one signal
 * common to all of them regardless of which component rendered it. Used to
 * dim the native title-bar overlay buttons, which otherwise never react to
 * a dialog's own backdrop since they're painted outside the web content.
 */
export function useAnyModalOpen(): boolean {
  const [open, setOpen] = useState(hasScrollLockClass)

  useEffect(() => {
    const observer = new MutationObserver(() => setOpen(hasScrollLockClass()))
    observer.observe(document.body, { attributes: true, attributeFilter: ["class"] })
    return () => observer.disconnect()
  }, [])

  return open
}
