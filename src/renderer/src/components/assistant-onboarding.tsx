import type { AiStatus } from "@/lib/electron"
import { Bot, Brain, Loader2, Lock, Server, Sparkles, Wrench } from "lucide-react"
import { useTranslation } from "react-i18next"
import { ProviderLogo } from "@/components/provider-logo"
import { Button } from "@/components/ui/button"
import { Card, CardContent } from "@/components/ui/card"
import { Input } from "@/components/ui/input"
import { cn } from "@/lib/utils"

const FEATURES = [
  {
    icon: Wrench,
    titleKey: "chat.onboarding.featurePlugins",
    descKey: "chat.onboarding.featurePluginsDesc",
  },
  {
    icon: Server,
    titleKey: "chat.onboarding.featureMcp",
    descKey: "chat.onboarding.featureMcpDesc",
  },
  {
    icon: Brain,
    titleKey: "chat.onboarding.featureMemory",
    descKey: "chat.onboarding.featureMemoryDesc",
  },
  {
    icon: Lock,
    titleKey: "chat.onboarding.featureSecure",
    descKey: "chat.onboarding.featureSecureDesc",
  },
] as const

const SAMPLE_PROMPT_KEYS = [
  "chat.onboarding.prompt1",
  "chat.onboarding.prompt2",
  "chat.onboarding.prompt3",
] as const

export function AssistantOnboarding({
  status,
  keyDraft,
  savingKey,
  onKeyDraftChange,
  onSaveKey,
  onOpenSettings,
}: {
  status: AiStatus
  keyDraft: string
  savingKey: boolean
  onKeyDraftChange: (value: string) => void
  onSaveKey: () => void
  onOpenSettings: () => void
}) {
  const { t } = useTranslation()
  const active = status.providers.find((provider) => provider.id === status.provider)
  const keyPlaceholder = status.provider === "anthropic" ? "sk-ant-…" : "sk-…"

  return (
    <div className="relative flex h-full min-h-0 flex-col overflow-hidden">
      <div aria-hidden className="pointer-events-none absolute inset-0 -z-10 overflow-hidden">
        <div className="absolute -top-24 left-1/2 size-[32rem] -translate-x-1/2 rounded-full bg-primary/[0.04] blur-3xl dark:bg-primary/[0.08]" />
        <div className="absolute right-0 bottom-0 size-72 translate-x-1/4 translate-y-1/4 rounded-full bg-chart-2/10 blur-3xl" />
        <div className="absolute bottom-1/3 left-0 size-56 -translate-x-1/3 rounded-full bg-chart-4/10 blur-3xl" />
      </div>

      <div className="flex flex-1 flex-col items-center justify-center px-4 py-10">
        <div className="w-full max-w-2xl space-y-8">
          <div className="space-y-4 text-center">
            <div className="relative mx-auto size-fit">
              <div
                aria-hidden
                className="absolute inset-0 -m-3 rounded-3xl bg-primary/10 blur-xl"
              />
              <div className="relative flex size-16 items-center justify-center rounded-2xl border border-primary/15 bg-gradient-to-br from-primary/15 via-primary/5 to-transparent shadow-sm">
                <Bot className="size-8 text-primary" />
              </div>
            </div>
            <div className="space-y-2">
              <h3 className="text-2xl font-semibold tracking-tight">
                {t("chat.onboarding.headline")}
              </h3>
              <p className="mx-auto max-w-lg text-sm leading-relaxed text-muted-foreground">
                {t("chat.onboarding.subtitle")}
              </p>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            {FEATURES.map(({ icon: Icon, titleKey, descKey }) => (
              <div
                key={titleKey}
                className="rounded-xl border bg-card/60 p-3 backdrop-blur-sm transition-colors hover:bg-card"
              >
                <div className="mb-2 flex size-8 items-center justify-center rounded-lg bg-primary/10 text-primary">
                  <Icon className="size-4" />
                </div>
                <p className="text-sm font-medium">{t(titleKey)}</p>
                <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{t(descKey)}</p>
              </div>
            ))}
          </div>

          <Card className="border-primary/10 bg-card/80 shadow-lg shadow-primary/[0.04] backdrop-blur-sm">
            <CardContent className="space-y-4 pt-6">
              <div className="flex items-start gap-3">
                <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/10">
                  <Sparkles className="size-4 text-primary" />
                </div>
                <div className="min-w-0 flex-1 space-y-1">
                  <p className="font-medium">{t("chat.onboarding.keyTitle")}</p>
                  <p className="text-sm text-muted-foreground">{t("chat.keyPrompt")}</p>
                </div>
              </div>

              {active && (
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                  <ProviderLogo id={active.id} label={active.label} className="size-4" />
                  <span>{t("chat.onboarding.keyHint", { provider: active.label })}</span>
                </div>
              )}

              <div className="flex gap-2">
                <Input
                  type="password"
                  value={keyDraft}
                  onChange={(event) => onKeyDraftChange(event.target.value)}
                  placeholder={keyPlaceholder}
                  className="font-mono text-sm"
                  onKeyDown={(event) => event.key === "Enter" && onSaveKey()}
                />
                <Button
                  onClick={onSaveKey}
                  disabled={savingKey || !keyDraft.trim()}
                  className="shrink-0"
                >
                  {savingKey && <Loader2 className="size-4 animate-spin" />}
                  {t("chat.saveKey")}
                </Button>
              </div>

              <div className="flex justify-center border-t pt-3">
                <Button
                  variant="link"
                  size="sm"
                  className="h-auto p-0 text-xs"
                  onClick={onOpenSettings}
                >
                  {t("chat.onboarding.otherProviders")}
                </Button>
              </div>
            </CardContent>
          </Card>

          <div className="space-y-3">
            <p className="text-center text-xs text-muted-foreground">
              {t("chat.onboarding.samplePrompts")}
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              {SAMPLE_PROMPT_KEYS.map((key) => (
                <span
                  key={key}
                  className={cn(
                    "rounded-full border border-dashed bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground"
                  )}
                >
                  {t(key)}
                </span>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
