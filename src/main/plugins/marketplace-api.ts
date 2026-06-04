import type {
  PluginDetailResponse,
  ResolveDownloadResponse,
  SearchPluginsResponse,
} from "@synapse/marketplace-types"
import process from "node:process"

// Client for the Synapse marketplace backend (the authoritative source).
// The desktop app browses public plugins and resolves signed download URLs
// through this; the legacy static registry (marketplace-registry.ts) remains a
// read-only fallback for offline/degraded operation.

export const DEFAULT_MARKETPLACE_API_URL = "http://localhost:8787"

export class MarketplaceApiError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = "MarketplaceApiError"
    this.status = status
    this.code = code
  }
}

export interface MarketplaceApiOptions {
  baseUrl?: string
  /** GET-only fetch; the host's narrowed `(url) => Promise<Response>` fits. */
  fetch?: (url: string) => Promise<Response>
}

export interface MarketplaceApi {
  search: (query?: string) => Promise<SearchPluginsResponse>
  detail: (pluginId: string) => Promise<PluginDetailResponse>
  resolveDownload: (pluginId: string, version: string) => Promise<ResolveDownloadResponse>
}

export function resolveMarketplaceBaseUrl(explicit?: string): string {
  return (explicit ?? process.env.SYNAPSE_MARKETPLACE_URL ?? DEFAULT_MARKETPLACE_API_URL).replace(
    /\/+$/,
    ""
  )
}

export function createMarketplaceApi(options: MarketplaceApiOptions = {}): MarketplaceApi {
  const doFetch = options.fetch ?? globalThis.fetch
  const base = resolveMarketplaceBaseUrl(options.baseUrl)

  async function getJson<T>(path: string): Promise<T> {
    let response: Response
    try {
      response = await doFetch(`${base}${path}`)
    } catch (err) {
      throw new MarketplaceApiError(
        0,
        "network_error",
        `Could not reach the marketplace: ${err instanceof Error ? err.message : String(err)}`
      )
    }
    if (!response.ok) {
      let code = "http_error"
      let message = `Marketplace request failed (${response.status})`
      try {
        const body = (await response.json()) as { error?: { code?: string; message?: string } }
        if (body.error?.code) code = body.error.code
        if (body.error?.message) message = body.error.message
      } catch {
        // non-JSON error body; keep defaults
      }
      throw new MarketplaceApiError(response.status, code, message)
    }
    return (await response.json()) as T
  }

  return {
    search(query?: string) {
      const suffix = query && query.trim() ? `?q=${encodeURIComponent(query.trim())}` : ""
      return getJson<SearchPluginsResponse>(`/plugins${suffix}`)
    },
    detail(pluginId: string) {
      return getJson<PluginDetailResponse>(`/plugins/${encodeURIComponent(pluginId)}`)
    },
    resolveDownload(pluginId: string, version: string) {
      return getJson<ResolveDownloadResponse>(
        `/plugins/${encodeURIComponent(pluginId)}/versions/${encodeURIComponent(version)}/download`
      )
    },
  }
}
