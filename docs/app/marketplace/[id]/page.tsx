import type { PluginDetailResponse } from "@synapsepkg/marketplace-types"
import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { derivePluginProfile, type ProfileLine } from "@synapsepkg/plugin-manifest"
import { fetchPlugin, localize } from "@/lib/marketplace"

const PROFILE_SUMMARY: Record<string, string> = {
  "profile.summary.cloud": "Connects to {{hosts}}",
  "profile.summary.cloudPending": "Requests access to {{hosts}} (not yet granted)",
  "profile.summary.credentialsBrokered":
    "Credentials are held by Synapse; the plugin cannot read your token",
  "profile.summary.credentialsBrokeredPending":
    "May use brokered credentials after you connect and grant access",
  "profile.summary.background": "Runs in the background",
  "profile.summary.backgroundPending":
    "Has background automation (not active until capabilities are granted)",
  "profile.summary.localRead": "Reads local files you scope",
  "profile.summary.localReadPending": "May read local files in allowed folders (not yet granted)",
  "profile.summary.agentCallable": "Exposes {{count}} tool(s) the agent can call",
}

const PROFILE_WARNING: Record<string, string> = {
  "profile.warning.remoteWriteback":
    "Can write back to remote services; writeback requires your confirmation",
  "profile.warning.remoteWritebackPending":
    "May write back to remote services once network access is granted",
  "profile.warning.localWrite": "Can write to local files in the folders you allow",
  "profile.warning.localWritePending": "May write local files once write access is granted",
  "profile.warning.approvalRequired": "High-risk actions require per-call approval",
  "profile.warning.unknownCapability": "Declares a capability this version does not recognize",
  "profile.warning.ungrantedCapabilities": "Some declared capabilities are not granted yet",
}

const PROFILE_CONTROL: Record<string, string> = {
  revoke: "Revocable",
  disconnect: "Disconnect credentials",
  "pause-background": "Pause background",
  "approval-required": "Approval required",
  audit: "Audited",
}

function renderLine(line: ProfileLine): string {
  const template = PROFILE_SUMMARY[line.code] ?? PROFILE_WARNING[line.code] ?? line.code
  return template.replace(/\{\{(\w+)\}\}/g, (_, key: string) => String(line.params?.[key] ?? ""))
}

function latestVersion(detail: PluginDetailResponse) {
  const target = detail.plugin.latestVersion
  return detail.versions.find((version) => version.version === target) ?? detail.versions[0]
}

export async function generateMetadata({
  params,
}: {
  params: Promise<{ id: string }>
}): Promise<Metadata> {
  const { id } = await params
  const detail = await fetchPlugin(decodeURIComponent(id)).catch(() => null)
  if (!detail) return { title: "Plugin not found · Synapse Marketplace" }
  const name = localize(detail.plugin.displayName)
  return {
    title: `${name} · Synapse Marketplace`,
    description: localize(detail.plugin.description),
  }
}

export default async function PluginDetailPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const detail = await fetchPlugin(decodeURIComponent(id)).catch(() => null)
  if (!detail) notFound()

  const latest = latestVersion(detail)
  const manifest = latest?.manifestSnapshot
  const permissions = (manifest?.capabilities ?? []).map((cap) => cap.id)
  const tools = manifest?.contributes.tools ?? []
  const profile = manifest ? derivePluginProfile({ manifest }) : null

  return (
    <main className="mx-auto max-w-3xl px-6 py-12">
      <Link href="/marketplace" className="text-sm text-neutral-500 hover:underline">
        ← Marketplace
      </Link>

      <header className="mt-4">
        <h1 className="text-3xl font-semibold tracking-tight">
          {localize(detail.plugin.displayName)}
        </h1>
        <p className="mt-2 text-neutral-500">{localize(detail.plugin.description)}</p>
        <div className="mt-3 flex flex-wrap items-center gap-3 text-sm text-neutral-400">
          <span>by {detail.ownerHandle}</span>
          {latest && <span>· v{latest.version}</span>}
          <span>· {detail.plugin.stats.downloads} downloads</span>
          {detail.plugin.stats.ratingCount > 0 && (
            <span>
              · ★ {detail.plugin.stats.ratingAvg.toFixed(1)} ({detail.plugin.stats.ratingCount})
            </span>
          )}
        </div>
      </header>

      {profile ? (
        <section className="mt-8 rounded-lg border border-neutral-200 p-4 dark:border-neutral-800">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-medium">Capabilities</h2>
            <span
              className={`rounded-md px-2 py-0.5 text-xs capitalize ${
                profile.riskLevel === "high"
                  ? "bg-red-500/15 text-red-600"
                  : profile.riskLevel === "medium"
                    ? "bg-amber-500/15 text-amber-600"
                    : "bg-emerald-500/15 text-emerald-600"
              }`}
            >
              {profile.riskLevel} risk
            </span>
          </div>
          {profile.summaries.length > 0 ? (
            <ul className="mt-2 space-y-1 text-sm text-neutral-600 dark:text-neutral-400">
              {profile.summaries.map((line) => (
                <li key={line.code}>{renderLine(line)}</li>
              ))}
            </ul>
          ) : null}
          {profile.warnings.length > 0 ? (
            <ul className="mt-2 space-y-1 text-sm text-amber-600">
              {profile.warnings.map((line) => (
                <li key={line.code}>⚠ {renderLine(line)}</li>
              ))}
            </ul>
          ) : null}
          {profile.controls.length > 0 ? (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {profile.controls.map((control) => (
                <span
                  key={control}
                  className="rounded-md border border-neutral-200 px-2 py-0.5 text-xs text-neutral-500 dark:border-neutral-700"
                >
                  {PROFILE_CONTROL[control] ?? control}
                </span>
              ))}
            </div>
          ) : null}
        </section>
      ) : null}

      <section className="mt-8">
        <h2 className="text-sm font-medium">Permissions requested</h2>
        {permissions.length === 0 ? (
          <p className="mt-2 text-sm text-neutral-500">No special permissions requested.</p>
        ) : (
          <div className="mt-2 flex flex-wrap gap-2">
            {permissions.map((permission) => (
              <span
                key={permission}
                className="rounded-md bg-neutral-100 px-2 py-1 font-mono text-xs dark:bg-neutral-800"
              >
                {permission}
              </span>
            ))}
          </div>
        )}
      </section>

      {tools.length > 0 && (
        <section className="mt-8">
          <h2 className="text-sm font-medium">AI tools exposed</h2>
          <ul className="mt-2 space-y-1.5 text-sm">
            {tools.map((tool) => (
              <li key={tool.name}>
                <span className="font-mono">{tool.name}</span>
                <span className="text-neutral-500"> — {tool.description}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="mt-8">
        <h2 className="text-sm font-medium">Version history</h2>
        <ul className="mt-2 flex flex-wrap gap-2">
          {detail.versions.map((version) => (
            <span
              key={version.version}
              className="rounded-md border border-neutral-200 px-2 py-1 text-xs text-neutral-500 dark:border-neutral-800"
            >
              v{version.version}
              {version.yankedAt ? " (yanked)" : ""}
            </span>
          ))}
        </ul>
      </section>

      <p className="mt-10 text-sm text-neutral-500">
        Install <span className="font-mono">{detail.plugin.id}</span> from the Synapse desktop app's
        marketplace.
      </p>
    </main>
  )
}
