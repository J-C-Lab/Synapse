import type { AiStatus } from "@/lib/electron"
import { Check, KeyRound, Loader2, ShieldOff } from "lucide-react"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Label } from "@/components/ui/label"
import { NativeSelect, NativeSelectOption } from "@/components/ui/native-select"
import {
  deleteAiKey,
  getAiStatus,
  isElectron,
  listAiAllowedTools,
  revokeAiTool,
  setAiKey,
  setAiModel,
  setAiProvider,
} from "@/lib/electron"

export function AiSettingsDialog({
  open,
  onOpenChange,
  status,
  onStatusChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  status: AiStatus | null
  onStatusChange: (status: AiStatus) => void
}) {
  const { t } = useTranslation()
  const [keyDraft, setKeyDraft] = useState("")
  const [busy, setBusy] = useState(false)
  const [allowed, setAllowed] = useState<string[]>([])

  const active = status?.providers.find((provider) => provider.id === status.provider)

  useEffect(() => {
    if (open && isElectron()) void listAiAllowedTools().then(setAllowed)
  }, [open])

  async function refresh() {
    onStatusChange(await getAiStatus())
  }

  async function revoke(fqName: string) {
    await revokeAiTool(fqName)
    setAllowed(await listAiAllowedTools())
  }

  async function mutate(action: () => Promise<void>) {
    if (busy || !isElectron()) return
    setBusy(true)
    try {
      await action()
      await refresh()
    } finally {
      setBusy(false)
    }
  }

  async function changeProvider(providerId: string) {
    setKeyDraft("")
    await mutate(() => setAiProvider(providerId))
  }

  async function changeModel(model: string) {
    if (!active) return
    await mutate(() => setAiModel(active.id, model))
  }

  async function saveKey() {
    if (!active || !keyDraft.trim()) return
    const providerId = active.id
    const key = keyDraft.trim()
    await mutate(async () => {
      await setAiKey(providerId, key)
      setKeyDraft("")
    })
  }

  async function clearKey() {
    if (!active) return
    await mutate(() => deleteAiKey(active.id))
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="gap-4 sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <KeyRound className="size-4" />
            {t("providers.title")}
          </DialogTitle>
          <DialogDescription>{t("providers.subtitle")}</DialogDescription>
        </DialogHeader>

        <div className="space-y-1">
          <Label className="text-xs">{t("providers.provider")}</Label>
          <NativeSelect
            value={status?.provider ?? ""}
            disabled={busy}
            onChange={(event) => void changeProvider(event.target.value)}
          >
            {status?.providers.map((provider) => (
              <NativeSelectOption key={provider.id} value={provider.id}>
                {provider.label}
                {provider.hasKey ? " ✓" : ""}
              </NativeSelectOption>
            ))}
          </NativeSelect>
        </div>

        {active && (
          <>
            <div className="space-y-1">
              <Label className="text-xs">{t("providers.model")}</Label>
              <NativeSelect
                value={active.model}
                disabled={busy}
                onChange={(event) => void changeModel(event.target.value)}
              >
                {(active.models.includes(active.model)
                  ? active.models
                  : [active.model, ...active.models]
                ).map((model) => (
                  <NativeSelectOption key={model} value={model}>
                    {model}
                  </NativeSelectOption>
                ))}
              </NativeSelect>
            </div>

            <div className="space-y-1">
              <Label className="text-xs">{t("providers.key")}</Label>
              {active.hasKey ? (
                <div className="flex items-center gap-2 text-sm text-muted-foreground">
                  <Check className="size-4 text-emerald-500" />
                  <span className="flex-1">{t("providers.keySet")}</span>
                  <Button variant="ghost" size="sm" disabled={busy} onClick={() => void clearKey()}>
                    {t("providers.clearKey")}
                  </Button>
                </div>
              ) : (
                <div className="flex gap-2">
                  <Input
                    type="password"
                    value={keyDraft}
                    disabled={busy}
                    onChange={(event) => setKeyDraft(event.target.value)}
                    placeholder={active.id === "anthropic" ? "sk-ant-…" : "sk-…"}
                    onKeyDown={(event) => event.key === "Enter" && void saveKey()}
                  />
                  <Button disabled={busy || !keyDraft.trim()} onClick={() => void saveKey()}>
                    {busy && <Loader2 className="size-4 animate-spin" />}
                    {t("providers.saveKey")}
                  </Button>
                </div>
              )}
              <p className="text-[11px] text-muted-foreground">{t("providers.keyHint")}</p>
            </div>
          </>
        )}

        <div className="space-y-1 border-t pt-3">
          <Label className="flex items-center gap-1.5 text-xs">
            <ShieldOff className="size-3.5" />
            {t("providers.allowedTools")}
          </Label>
          {allowed.length === 0 ? (
            <p className="text-[11px] text-muted-foreground">{t("providers.allowedEmpty")}</p>
          ) : (
            <div className="space-y-1">
              {allowed.map((fqName) => (
                <div
                  key={fqName}
                  className="flex items-center gap-2 rounded-md border px-2 py-1 text-xs"
                >
                  <span className="min-w-0 flex-1 truncate font-mono">{fqName}</span>
                  <Button
                    variant="ghost"
                    size="sm"
                    className="h-6"
                    disabled={busy}
                    onClick={() => void revoke(fqName)}
                  >
                    {t("providers.revoke")}
                  </Button>
                </div>
              ))}
            </div>
          )}
        </div>
      </DialogContent>
    </Dialog>
  )
}
