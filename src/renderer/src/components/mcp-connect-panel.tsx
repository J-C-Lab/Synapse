import type { McpOnboardingAvailability } from "@/lib/electron"
import { useEffect, useState } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import {
  generateMcpOnboardingConfig,
  getMcpOnboardingAvailability,
  testMcpOnboardingConnection,
} from "@/lib/electron"

export function McpConnectPanel({ workspaceId }: { workspaceId: string }) {
  const { t } = useTranslation()
  const [availability, setAvailability] = useState<McpOnboardingAvailability>({ available: false })
  const [config, setConfig] = useState<string | undefined>()
  const [copied, setCopied] = useState(false)
  const [testStatus, setTestStatus] = useState<
    | { kind: "idle" }
    | { kind: "running" }
    | { kind: "success"; toolCount: number; resourceCount: number }
    | { kind: "failure"; message: string }
  >({ kind: "idle" })

  useEffect(() => {
    void getMcpOnboardingAvailability(workspaceId).then(setAvailability)
  }, [workspaceId])

  async function onGenerate() {
    const json = await generateMcpOnboardingConfig(workspaceId)
    setConfig(json)
    setCopied(false)
  }

  async function onCopy() {
    if (!config) return
    await navigator.clipboard.writeText(config)
    setCopied(true)
  }

  async function onTest() {
    setTestStatus({ kind: "running" })
    try {
      const result = await testMcpOnboardingConnection(workspaceId)
      setTestStatus({ kind: "success", ...result })
    } catch (err) {
      setTestStatus({
        kind: "failure",
        message: err instanceof Error ? err.message : String(err),
      })
    }
  }

  const disabled = !availability.available

  return (
    <div className="flex flex-col gap-2 rounded-md border p-3">
      <div className="flex flex-col gap-0.5">
        <span className="text-sm font-medium">{t("mcpOnboarding.title")}</span>
        <span className="text-xs text-muted-foreground">{t("mcpOnboarding.subtitle")}</span>
      </div>
      {availability.reason === "dev-build" && (
        <p className="text-xs text-muted-foreground">{t("mcpOnboarding.devNote")}</p>
      )}
      {availability.reason === "archived" && (
        <p className="text-xs text-muted-foreground">{t("mcpOnboarding.archivedNote")}</p>
      )}
      <div className="flex gap-2">
        <Button size="sm" variant="outline" disabled={disabled} onClick={() => void onGenerate()}>
          {t("mcpOnboarding.generateButton")}
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={disabled || testStatus.kind === "running"}
          onClick={() => void onTest()}
        >
          {testStatus.kind === "running"
            ? t("mcpOnboarding.testRunning")
            : t("mcpOnboarding.testButton")}
        </Button>
      </div>
      {config && (
        <div className="flex flex-col gap-1">
          <pre className="max-h-48 overflow-auto rounded bg-muted p-2 text-xs">{config}</pre>
          <Button size="sm" variant="ghost" className="self-start" onClick={() => void onCopy()}>
            {copied ? t("mcpOnboarding.copiedLabel") : t("mcpOnboarding.copyButton")}
          </Button>
        </div>
      )}
      {testStatus.kind === "success" && (
        <p className="text-xs text-muted-foreground">
          {t("mcpOnboarding.testSuccess", {
            toolCount: testStatus.toolCount,
            resourceCount: testStatus.resourceCount,
          })}
        </p>
      )}
      {testStatus.kind === "failure" && (
        <p className="text-xs text-destructive">
          {t("mcpOnboarding.testFailure", { message: testStatus.message })}
        </p>
      )}
    </div>
  )
}
