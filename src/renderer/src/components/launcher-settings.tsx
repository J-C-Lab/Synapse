import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { getSettings, isElectron, refreshApps, updateSettings } from "@/lib/electron"

/**
 * Lets the user rebind the global launcher hotkey from the main window
 * and trigger a manual re-scan of installed apps. Kept intentionally
 * minimal — full settings UI is a later milestone.
 */
export function LauncherSettings() {
  const { t } = useTranslation()
  const [hotkey, setHotkey] = useState("")
  const [savedHotkey, setSavedHotkey] = useState("")
  const [status, setStatus] = useState<{ kind: "ok" | "error"; text: string } | null>(null)
  const [refreshing, setRefreshing] = useState(false)

  useEffect(() => {
    if (!isElectron()) return
    void getSettings().then((settings) => {
      setHotkey(settings.hotkey)
      setSavedHotkey(settings.hotkey)
    })
  }, [])

  if (!isElectron()) return null

  async function onSave() {
    setStatus(null)
    try {
      const next = await updateSettings({ hotkey })
      setSavedHotkey(next.hotkey)
      setStatus({ kind: "ok", text: t("launcher.settings.saved") })
    } catch (err) {
      setStatus({
        kind: "error",
        text: err instanceof Error ? err.message : String(err),
      })
    }
  }

  async function onRefresh() {
    setRefreshing(true)
    try {
      await refreshApps()
      setStatus({ kind: "ok", text: t("launcher.settings.rescanned") })
    } finally {
      setRefreshing(false)
    }
  }

  return (
    <section className="flex w-full max-w-md flex-col gap-3 rounded-lg border border-border bg-card p-4">
      <h2 className="text-lg font-medium">{t("launcher.settings.title")}</h2>
      <p className="text-sm text-muted-foreground">{t("launcher.settings.hint")}</p>

      <div className="flex flex-col gap-2">
        <Label htmlFor="hotkey-input">{t("launcher.settings.hotkeyLabel")}</Label>
        <div className="flex gap-2">
          <Input
            id="hotkey-input"
            value={hotkey}
            onChange={(e) => setHotkey(e.target.value)}
            placeholder="Control+Space"
            spellCheck={false}
          />
          <Button onClick={onSave} disabled={!hotkey.trim() || hotkey === savedHotkey}>
            {t("launcher.settings.save")}
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">{t("launcher.settings.examples")}</p>
      </div>

      <div className="flex items-center justify-between">
        <span className="text-sm">
          {t("launcher.settings.active")}: <code>{savedHotkey}</code>
        </span>
        <Button variant="outline" size="sm" onClick={onRefresh} disabled={refreshing}>
          {refreshing ? t("launcher.settings.rescanning") : t("launcher.settings.rescan")}
        </Button>
      </div>

      {status && (
        <p
          className={
            status.kind === "ok"
              ? "text-sm text-green-600 dark:text-green-400"
              : "text-sm text-red-500"
          }
        >
          {status.text}
        </p>
      )}
    </section>
  )
}
