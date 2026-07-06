import type { PluginManifest } from "@synapse/plugin-manifest"
import type { PluginCapabilityProfile } from "@/lib/electron"
import { useEffect, useState } from "react"
import { getPluginCapabilityProfile, previewPluginCapabilityProfile } from "@/lib/electron"

const profileCache = new Map<string, PluginCapabilityProfile>()
const profileInflight = new Map<string, Promise<PluginCapabilityProfile | null>>()
const profileInvalidationListeners = new Set<(pluginId?: string) => void>()

const catalogCache = new Map<string, PluginCapabilityProfile>()
const catalogInflight = new Map<string, Promise<PluginCapabilityProfile | null>>()

function catalogCacheKey(manifest: PluginManifest): string {
  return `${manifest.id}@${manifest.version}:${JSON.stringify(manifest)}`
}

export function invalidateCapabilityProfileCache(pluginId?: string): void {
  if (pluginId) {
    profileCache.delete(pluginId)
    profileInflight.delete(pluginId)
    for (const listener of profileInvalidationListeners) listener(pluginId)
    return
  }
  profileCache.clear()
  profileInflight.clear()
  catalogCache.clear()
  catalogInflight.clear()
  for (const listener of profileInvalidationListeners) listener(undefined)
}

export function useCapabilityProfile(pluginId: string | undefined): PluginCapabilityProfile | null {
  const [revision, setRevision] = useState(0)
  const [profile, setProfile] = useState<PluginCapabilityProfile | null>(() =>
    pluginId ? (profileCache.get(pluginId) ?? null) : null
  )

  useEffect(() => {
    if (!pluginId) return
    const listener = (invalidatedPluginId?: string) => {
      if (invalidatedPluginId && invalidatedPluginId !== pluginId) return
      setRevision((value) => value + 1)
    }
    profileInvalidationListeners.add(listener)
    return () => {
      profileInvalidationListeners.delete(listener)
    }
  }, [pluginId])

  useEffect(() => {
    if (!pluginId) {
      setProfile(null)
      return
    }

    const cached = profileCache.get(pluginId)
    if (cached) {
      setProfile(cached)
      return
    }

    let alive = true
    let promise = profileInflight.get(pluginId)
    if (!promise) {
      promise = getPluginCapabilityProfile(pluginId)
        .then((value) => {
          if (value) profileCache.set(pluginId, value)
          return value
        })
        .catch(() => null)
        .finally(() => {
          profileInflight.delete(pluginId)
        })
      profileInflight.set(pluginId, promise)
    }

    void promise.then((value) => alive && setProfile(value))
    return () => {
      alive = false
    }
  }, [pluginId, revision])

  return profile
}

/** 装前目录视图：manifest + 空授权集 → pending 文案（marketplace 未安装插件）。 */
export function useCatalogCapabilityProfile(
  manifest: PluginManifest | undefined,
  skip: boolean
): PluginCapabilityProfile | null {
  const cacheKey = manifest && !skip ? catalogCacheKey(manifest) : undefined
  const [profile, setProfile] = useState<PluginCapabilityProfile | null>(() =>
    cacheKey ? (catalogCache.get(cacheKey) ?? null) : null
  )

  useEffect(() => {
    if (!manifest || skip) {
      setProfile(null)
      return
    }

    const key = catalogCacheKey(manifest)
    const cached = catalogCache.get(key)
    if (cached) {
      setProfile(cached)
      return
    }

    let alive = true
    let promise = catalogInflight.get(key)
    if (!promise) {
      promise = previewPluginCapabilityProfile(manifest)
        .then((value) => {
          catalogCache.set(key, value)
          return value
        })
        .catch(() => null)
        .finally(() => {
          catalogInflight.delete(key)
        })
      catalogInflight.set(key, promise)
    }

    void promise.then((value) => alive && setProfile(value))
    return () => {
      alive = false
    }
  }, [manifest, skip])

  return profile
}
