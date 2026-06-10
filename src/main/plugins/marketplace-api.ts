import type {
  DeviceCodePollResponse,
  DeviceCodeStartResponse,
  PluginDetailResponse,
  RateResponse,
  ResolveDownloadResponse,
  SearchPluginsResponse,
  SessionResponse,
} from "@synapse/marketplace-types"
import process from "node:process"

// Client for the Synapse marketplace backend (the authoritative source).
// The desktop app browses plugins, resolves signed download URLs, and — when
// signed in — sends a bearer token so owners see private plugins and can rate.
// The legacy static registry (marketplace-registry.ts) remains a read-only
// fallback for offline/degraded operation.

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
  fetch?: (url: string, init?: RequestInit) => Promise<Response>
  /** Supplies the current session token for authenticated requests, if any. */
  getToken?: () => Promise<string | undefined> | string | undefined
}

export interface MarketplaceApi {
  search: (query?: string) => Promise<SearchPluginsResponse>
  detail: (pluginId: string) => Promise<PluginDetailResponse>
  resolveDownload: (pluginId: string, version: string) => Promise<ResolveDownloadResponse>
  rate: (pluginId: string, stars: number) => Promise<RateResponse>
  session: () => Promise<SessionResponse>
  deviceStart: () => Promise<DeviceCodeStartResponse>
  devicePoll: (deviceCode: string) => Promise<DeviceCodePollResponse>
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

  async function authHeader(): Promise<Record<string, string>> {
    const token = options.getToken ? await options.getToken() : undefined
    return token ? { authorization: `Bearer ${token}` } : {}
  }

  async function handle<T>(response: Response): Promise<T> {
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

  async function get<T>(path: string): Promise<T> {
    const headers = await authHeader()
    try {
      const response =
        Object.keys(headers).length > 0
          ? await doFetch(`${base}${path}`, { headers })
          : await doFetch(`${base}${path}`)
      return await handle<T>(response)
    } catch (err) {
      throw asApiError(err)
    }
  }

  async function send<T>(path: string, method: string, body: unknown): Promise<T> {
    const headers = { "content-type": "application/json", ...(await authHeader()) }
    try {
      const response = await doFetch(`${base}${path}`, {
        method,
        headers,
        body: JSON.stringify(body),
      })
      return await handle<T>(response)
    } catch (err) {
      throw asApiError(err)
    }
  }

  return {
    search(query?: string) {
      const suffix = query && query.trim() ? `?q=${encodeURIComponent(query.trim())}` : ""
      return get<SearchPluginsResponse>(`/plugins${suffix}`)
    },
    detail(pluginId: string) {
      return get<PluginDetailResponse>(`/plugins/${encodeURIComponent(pluginId)}`)
    },
    resolveDownload(pluginId: string, version: string) {
      return get<ResolveDownloadResponse>(
        `/plugins/${encodeURIComponent(pluginId)}/versions/${encodeURIComponent(version)}/download`
      )
    },
    rate(pluginId: string, stars: number) {
      return send<RateResponse>(`/plugins/${encodeURIComponent(pluginId)}/rating`, "PUT", { stars })
    },
    session() {
      return get<SessionResponse>("/session")
    },
    deviceStart() {
      return send<DeviceCodeStartResponse>("/auth/device/start", "POST", {})
    },
    devicePoll(deviceCode: string) {
      return send<DeviceCodePollResponse>("/auth/device/poll", "POST", { deviceCode })
    },
  }
}

function asApiError(err: unknown): MarketplaceApiError {
  if (err instanceof MarketplaceApiError) return err
  return new MarketplaceApiError(
    0,
    "network_error",
    `Could not reach the marketplace: ${err instanceof Error ? err.message : String(err)}`
  )
}
