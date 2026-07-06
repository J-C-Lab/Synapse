import type { AiStatus } from "@/lib/electron"
import { Activity, Check, Gauge, KeyRound, Loader2, ShieldOff } from "lucide-react"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { ProviderLogo } from "@/components/provider-logo"
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
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select"
import { Switch } from "@/components/ui/switch"
import {
  deleteAiKey,
  getAiStatus,
  isElectron,
  listAiAllowedTools,
  revokeAiTool,
  setAiBudget,
  setAiContextCompression,
  setAiKey,
  setAiModel,
  setAiProvider,
  setAiToolResilience,
} from "@/lib/electron"

interface ResilienceDraft {
  failureThreshold: string
  recoverySec: string
  timeoutSec: string
}

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
  // null = show the persisted budget; a string = the user is editing.
  const [budgetDraft, setBudgetDraft] = useState<string | null>(null)
  const [compressionThresholdDraft, setCompressionThresholdDraft] = useState<string | null>(null)
  const [resilienceDraft, setResilienceDraft] = useState<ResilienceDraft | null>(null)
  const [busy, setBusy] = useState(false)
  const [allowed, setAllowed] = useState<string[]>([])

  const active = status?.providers.find((provider) => provider.id === status.provider)
  const budgetValue = budgetDraft ?? (status?.budgetTokens ? String(status.budgetTokens) : "")
  const compression = status?.contextCompression ?? { enabled: false, thresholdTokens: 0 }
  const compressionThresholdValue =
    compressionThresholdDraft ??
    (compression.thresholdTokens > 0 ? String(compression.thresholdTokens) : "")
  const resilience = status?.toolResilience ?? {
    failureThreshold: 5,
    recoveryMs: 60_000,
    timeoutMs: 30_000,
  }
  const failureThresholdValue =
    resilienceDraft?.failureThreshold ?? String(resilience.failureThreshold)
  const recoverySecValue =
    resilienceDraft?.recoverySec ?? String(Math.round(resilience.recoveryMs / 1000))
  const timeoutSecValue =
    resilienceDraft?.timeoutSec ?? String(Math.round(resilience.timeoutMs / 1000))

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

  async function saveBudget() {
    const parsed = Number.parseInt(budgetValue, 10)
    const tokens = Number.isFinite(parsed) && parsed > 0 ? parsed : 0
    await mutate(() => setAiBudget(tokens))
    setBudgetDraft(null) // fall back to the freshly persisted value
  }

  async function saveContextCompression(enabled: boolean) {
    const parsed = Number.parseInt(compressionThresholdValue, 10)
    const thresholdTokens = Number.isFinite(parsed) && parsed > 0 ? parsed : 100_000
    await mutate(() => setAiContextCompression({ enabled, thresholdTokens }))
    setCompressionThresholdDraft(null)
  }

  async function saveCompressionThreshold() {
    await saveContextCompression(compression.enabled)
  }

  function setResilience(patch: Partial<ResilienceDraft>) {
    setResilienceDraft({
      failureThreshold: failureThresholdValue,
      recoverySec: recoverySecValue,
      timeoutSec: timeoutSecValue,
      ...patch,
    })
  }

  async function saveResilience() {
    const failureThreshold = Math.max(1, Number.parseInt(failureThresholdValue, 10) || 5)
    const recoverySec = Math.max(0, Number.parseInt(recoverySecValue, 10) || 0)
    const timeoutSec = Math.max(0, Number.parseInt(timeoutSecValue, 10) || 0)
    await mutate(() =>
      setAiToolResilience({
        failureThreshold,
        recoveryMs: recoverySec * 1000,
        timeoutMs: timeoutSec * 1000,
      })
    )
    setResilienceDraft(null)
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          setBudgetDraft(null)
          setCompressionThresholdDraft(null)
          setResilienceDraft(null)
        }
        onOpenChange(next)
      }}
    >
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
          <Select
            value={status?.provider ?? ""}
            disabled={busy}
            onValueChange={(value) => void changeProvider(value)}
          >
            <SelectTrigger className="w-full">
              <SelectValue placeholder={t("providers.provider")} />
            </SelectTrigger>
            <SelectContent>
              {status?.providers.map((provider) => (
                <SelectItem key={provider.id} value={provider.id}>
                  <span className="flex items-center gap-2">
                    <ProviderLogo id={provider.id} label={provider.label} className="size-4" />
                    <span className="truncate">{provider.label}</span>
                    {provider.hasKey && <Check className="size-3.5 text-emerald-500" />}
                  </span>
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
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
            <Gauge className="size-3.5" />
            {t("providers.budget")}
          </Label>
          <div className="flex gap-2">
            <Input
              type="number"
              min={0}
              step={1000}
              value={budgetValue}
              disabled={busy}
              onChange={(event) => setBudgetDraft(event.target.value)}
              placeholder={t("providers.budgetUnlimited")}
              onKeyDown={(event) => event.key === "Enter" && void saveBudget()}
            />
            <Button variant="secondary" disabled={busy} onClick={() => void saveBudget()}>
              {t("providers.budgetSave")}
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">{t("providers.budgetHint")}</p>
        </div>

        <div className="space-y-2 border-t pt-3">
          <div className="flex items-center justify-between gap-2">
            <Label className="text-xs">{t("providers.contextCompression")}</Label>
            <Switch
              checked={compression.enabled}
              disabled={busy}
              onCheckedChange={(checked) => void saveContextCompression(checked)}
            />
          </div>
          <div className="flex gap-2">
            <Input
              type="number"
              min={0}
              step={10000}
              value={compressionThresholdValue}
              disabled={busy || !compression.enabled}
              onChange={(event) => setCompressionThresholdDraft(event.target.value)}
              placeholder={t("providers.contextCompressionThresholdPlaceholder")}
              onKeyDown={(event) => event.key === "Enter" && void saveCompressionThreshold()}
            />
            <Button
              variant="secondary"
              disabled={busy || !compression.enabled}
              onClick={() => void saveCompressionThreshold()}
            >
              {t("providers.budgetSave")}
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            {t("providers.contextCompressionHint")}
          </p>
        </div>

        <div className="space-y-2 border-t pt-3">
          <Label className="flex items-center gap-1.5 text-xs">
            <Activity className="size-3.5" />
            {t("providers.toolResilience")}
          </Label>
          <div className="grid grid-cols-3 gap-2">
            <ResilienceField label={t("providers.toolResilienceFailures")}>
              <Input
                type="number"
                min={1}
                step={1}
                value={failureThresholdValue}
                disabled={busy}
                onChange={(event) => setResilience({ failureThreshold: event.target.value })}
                onKeyDown={(event) => event.key === "Enter" && void saveResilience()}
              />
            </ResilienceField>
            <ResilienceField label={t("providers.toolResilienceRecovery")}>
              <Input
                type="number"
                min={0}
                step={5}
                value={recoverySecValue}
                disabled={busy}
                onChange={(event) => setResilience({ recoverySec: event.target.value })}
                onKeyDown={(event) => event.key === "Enter" && void saveResilience()}
              />
            </ResilienceField>
            <ResilienceField label={t("providers.toolResilienceTimeout")}>
              <Input
                type="number"
                min={0}
                step={5}
                value={timeoutSecValue}
                disabled={busy}
                onChange={(event) => setResilience({ timeoutSec: event.target.value })}
                onKeyDown={(event) => event.key === "Enter" && void saveResilience()}
              />
            </ResilienceField>
          </div>
          <div className="flex justify-end">
            <Button
              variant="secondary"
              size="sm"
              disabled={busy}
              onClick={() => void saveResilience()}
            >
              {t("providers.budgetSave")}
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">{t("providers.toolResilienceHint")}</p>
        </div>

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

function ResilienceField({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1">
      <Label className="text-[10px] text-muted-foreground">{label}</Label>
      {children}
    </div>
  )
}
