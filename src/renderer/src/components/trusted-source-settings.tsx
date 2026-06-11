import { ShieldCheck } from "lucide-react"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { toast } from "sonner"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card"
import { Label } from "@/components/ui/label"
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group"
import { getSettings, isElectron, updateSettings } from "@/lib/electron"

const POLICIES = ["official-marketplace", "any-url", "local-syn"] as const
type TrustedSourcePolicy = (typeof POLICIES)[number]

function isTrustedSourcePolicy(value: string): value is TrustedSourcePolicy {
  return (POLICIES as readonly string[]).includes(value)
}

export function TrustedSourceSettings() {
  const { t } = useTranslation()
  const [policy, setPolicy] = useState<TrustedSourcePolicy>("official-marketplace")
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!isElectron()) return
    let active = true
    void getSettings().then((settings) => {
      if (active) setPolicy(settings.trustedSourcePolicy)
    })
    return () => {
      active = false
    }
  }, [])

  if (!isElectron()) return null

  async function choose(next: string) {
    if (!isTrustedSourcePolicy(next) || next === policy) return
    const previous = policy
    setPolicy(next)
    setSaving(true)
    try {
      const settings = await updateSettings({ trustedSourcePolicy: next })
      setPolicy(settings.trustedSourcePolicy)
      toast.success(t("trustedSources.saved"))
    } catch (err) {
      setPolicy(previous)
      toast.error(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <ShieldCheck className="size-4 text-primary" aria-hidden />
          {t("trustedSources.title")}
        </CardTitle>
        <CardDescription>{t("trustedSources.subtitle")}</CardDescription>
      </CardHeader>
      <CardContent>
        <RadioGroup
          value={policy}
          onValueChange={(value) => void choose(value)}
          aria-label={t("trustedSources.title")}
          className="grid gap-3 md:grid-cols-3"
          disabled={saving}
        >
          {POLICIES.map((item) => (
            <Label
              key={item}
              htmlFor={`trusted-source-${item}`}
              className="flex min-h-24 cursor-pointer items-start gap-3 rounded-md border p-3 text-sm hover:bg-accent/50 has-[[data-state=checked]]:border-primary"
            >
              <RadioGroupItem
                id={`trusted-source-${item}`}
                value={item}
                aria-label={t(`trustedSources.policy.${policyKey(item)}`)}
                className="mt-0.5"
                disabled={saving}
              />
              <span className="grid gap-1">
                <span className="font-medium">{t(`trustedSources.policy.${policyKey(item)}`)}</span>
                <span className="text-xs leading-5 text-muted-foreground">
                  {t(`trustedSources.policy.${policyKey(item)}Hint`)}
                </span>
              </span>
            </Label>
          ))}
        </RadioGroup>
      </CardContent>
    </Card>
  )
}

function policyKey(policy: TrustedSourcePolicy): string {
  switch (policy) {
    case "official-marketplace":
      return "officialMarketplace"
    case "any-url":
      return "anyUrl"
    case "local-syn":
      return "localSyn"
  }
}
