import type { Metadata } from "next"
import Link from "next/link"
import { fetchPlugins, localize } from "@/lib/marketplace"

export const metadata: Metadata = {
  title: "Synapse Plugin Marketplace",
  description: "Discover and install Synapse plugins — tools that give the AI new hands.",
}

export default async function MarketplacePage({
  searchParams,
}: {
  searchParams: Promise<{ q?: string }>
}) {
  const { q } = await searchParams
  const result = await fetchPlugins(q).catch(() => null)

  return (
    <main className="mx-auto max-w-5xl px-6 py-12">
      <header className="mb-8">
        <h1 className="text-3xl font-semibold tracking-tight">Plugin Marketplace</h1>
        <p className="mt-2 text-neutral-500">
          Discover Synapse plugins. Install them from the desktop app.
        </p>
      </header>

      <form action="/marketplace" method="get" className="mb-8">
        <input
          type="search"
          name="q"
          defaultValue={q ?? ""}
          placeholder="Search plugins…"
          className="w-full rounded-lg border border-neutral-300 bg-transparent px-4 py-2 outline-none focus:border-neutral-500 dark:border-neutral-700"
        />
      </form>

      {!result ? (
        <p className="text-neutral-500">The marketplace is temporarily unavailable.</p>
      ) : result.items.length === 0 ? (
        <p className="text-neutral-500">No plugins match your search.</p>
      ) : (
        <ul className="grid gap-4 sm:grid-cols-2">
          {result.items.map((plugin) => (
            <li key={plugin.id}>
              <Link
                href={`/marketplace/${encodeURIComponent(plugin.id)}`}
                className="block rounded-xl border border-neutral-200 p-5 transition hover:border-neutral-400 dark:border-neutral-800 dark:hover:border-neutral-600"
              >
                <div className="flex items-center justify-between gap-3">
                  <h2 className="truncate text-lg font-medium">{localize(plugin.displayName)}</h2>
                  {plugin.latestVersion && (
                    <span className="shrink-0 text-xs text-neutral-500">
                      v{plugin.latestVersion}
                    </span>
                  )}
                </div>
                <p className="mt-1 line-clamp-2 text-sm text-neutral-500">
                  {localize(plugin.description)}
                </p>
                <div className="mt-3 flex items-center gap-3 text-xs text-neutral-400">
                  <span>by {plugin.ownerHandle}</span>
                  <span>·</span>
                  <span>{plugin.stats.downloads} downloads</span>
                  {plugin.stats.ratingCount > 0 && (
                    <span>
                      · ★ {plugin.stats.ratingAvg.toFixed(1)} ({plugin.stats.ratingCount})
                    </span>
                  )}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </main>
  )
}
