import type { PluginDetailResponse } from "@synapse/marketplace-types"
import type { Metadata } from "next"
import Link from "next/link"
import { notFound } from "next/navigation"
import { fetchPlugin, localize } from "@/lib/marketplace"

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
  const permissions = manifest?.permissions ?? []
  const tools = manifest?.contributes.tools ?? []

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
