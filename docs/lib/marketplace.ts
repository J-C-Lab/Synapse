import type {
  LocalizedString,
  PluginDetailResponse,
  SearchPluginsResponse,
} from "@synapse/marketplace-types"

// Read-only client for the marketplace public API, used by the web portal's
// server components. Only public, active plugins are returned by these
// endpoints, so the portal needs no auth.

export function marketplaceApiBase(): string {
  return (process.env.MARKETPLACE_URL ?? "http://localhost:8787").replace(/\/+$/, "")
}

export async function fetchPlugins(query?: string): Promise<SearchPluginsResponse> {
  const suffix = query && query.trim() ? `?q=${encodeURIComponent(query.trim())}` : ""
  const response = await fetch(`${marketplaceApiBase()}/plugins${suffix}`, {
    next: { revalidate: 60 },
  })
  if (!response.ok) {
    throw new Error(`Marketplace request failed (${response.status})`)
  }
  return (await response.json()) as SearchPluginsResponse
}

export async function fetchPlugin(id: string): Promise<PluginDetailResponse | null> {
  const response = await fetch(`${marketplaceApiBase()}/plugins/${encodeURIComponent(id)}`, {
    next: { revalidate: 60 },
  })
  if (response.status === 404) return null
  if (!response.ok) {
    throw new Error(`Marketplace request failed (${response.status})`)
  }
  return (await response.json()) as PluginDetailResponse
}

/** Pick a string out of a localized field (single string or locale→string map). */
export function localize(value: LocalizedString, locale = "en"): string {
  if (typeof value === "string") return value
  return value[locale] ?? value.en ?? Object.values(value)[0] ?? ""
}
