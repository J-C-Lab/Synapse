import type { ReactNode } from "react"
import { createContext, use, useCallback, useEffect, useMemo, useState } from "react"
import { getSettings, isElectron, onSettingsChanged, updateSettings } from "@/lib/electron"

type ResolvedScheme = "light" | "dark"

interface ThemeContextValue {
  themeMode: DeskitThemeMode
  accent: DeskitThemeAccent
  resolvedScheme: ResolvedScheme
  setThemeMode: (mode: DeskitThemeMode) => void
  setAccent: (accent: DeskitThemeAccent) => void
}

const ThemeContext = createContext<ThemeContextValue | null>(null)

function detectSystemScheme(): ResolvedScheme {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return "light"
  }
  return window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light"
}

function resolveScheme(mode: DeskitThemeMode): ResolvedScheme {
  return mode === "system" ? detectSystemScheme() : mode
}

function applyToDom(scheme: ResolvedScheme, accent: DeskitThemeAccent): void {
  if (typeof document === "undefined") return
  const root = document.documentElement
  root.classList.toggle("dark", scheme === "dark")
  // Neutral is the default and intentionally has no data-accent block;
  // removing the attribute keeps the cascade simple.
  if (accent === "neutral") root.removeAttribute("data-accent")
  else root.setAttribute("data-accent", accent)
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [themeMode, setThemeMode] = useState<DeskitThemeMode>("system")
  const [accent, setAccent] = useState<DeskitThemeAccent>("neutral")
  const [loaded, setLoaded] = useState(() => !isElectron())

  // First paint — apply the OS preference immediately so the very first
  // frame is in the right scheme. Once settings come back from IPC the
  // effect below overwrites this with the user's choice.
  useEffect(() => {
    applyToDom(detectSystemScheme(), "neutral")
  }, [])

  // Pull persisted settings as the source of truth. Outside Electron
  // (e.g. unit tests via jsdom) we just keep defaults.
  useEffect(() => {
    if (!isElectron()) return
    let cancelled = false
    void getSettings()
      .then((s) => {
        if (cancelled) return
        setThemeMode(s.themeMode)
        setAccent(s.accent)
        setLoaded(true)
      })
      .catch((err: unknown) => {
        if (cancelled) return
        console.warn("[deskit] failed to load settings; using defaults", err)
        setLoaded(true)
      })
    return () => {
      cancelled = true
    }
  }, [])

  // The launcher window stays mounted across hide/show, so it never
  // re-fetches settings on its own. Main process broadcasts after every
  // settings:update so both windows stay in sync.
  useEffect(() => {
    if (!isElectron()) return
    return onSettingsChanged((s) => {
      setThemeMode(s.themeMode)
      setAccent(s.accent)
    })
  }, [])

  useEffect(() => {
    if (!loaded) return
    applyToDom(resolveScheme(themeMode), accent)
  }, [themeMode, accent, loaded])

  // Live-follow OS preference only while the user is in "system" mode.
  useEffect(() => {
    if (themeMode !== "system" || typeof window === "undefined") return
    const mql = window.matchMedia("(prefers-color-scheme: dark)")
    const onChange = (): void => applyToDom(detectSystemScheme(), accent)
    mql.addEventListener("change", onChange)
    return () => mql.removeEventListener("change", onChange)
  }, [themeMode, accent])

  const updateThemeMode = useCallback((mode: DeskitThemeMode) => {
    setThemeMode(mode)
    if (isElectron()) void updateSettings({ themeMode: mode })
  }, [])

  const updateAccent = useCallback((next: DeskitThemeAccent) => {
    setAccent(next)
    if (isElectron()) void updateSettings({ accent: next })
  }, [])

  const value = useMemo<ThemeContextValue>(
    () => ({
      themeMode,
      accent,
      resolvedScheme: resolveScheme(themeMode),
      setThemeMode: updateThemeMode,
      setAccent: updateAccent,
    }),
    [themeMode, accent, updateThemeMode, updateAccent]
  )

  return <ThemeContext value={value}>{children}</ThemeContext>
}

// Co-locating the hook with its provider is a deliberate, conventional
// shape for a context module; splitting into two files just to satisfy
// Fast Refresh adds friction with no real upside.
// eslint-disable-next-line react-refresh/only-export-components
export function useTheme(): ThemeContextValue {
  const ctx = use(ThemeContext)
  if (!ctx) throw new Error("useTheme must be used within <ThemeProvider>")
  return ctx
}
