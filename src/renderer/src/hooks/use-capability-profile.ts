import type { PluginManifest } from "@synapse/plugin-manifest"
import type { PluginCapabilityProfile } from "@/lib/electron"
import { useEffect, useState } from "react"
import { getPluginCapabilityProfile, previewPluginCapabilityProfile } from "@/lib/electron"

export function useCapabilityProfile(pluginId: string | undefined): PluginCapabilityProfile | null {
  const [profile, setProfile] = useState<PluginCapabilityProfile | null>(null)

  useEffect(() => {
    if (!pluginId) {
      setProfile(null)
      return
    }
    let alive = true
    void getPluginCapabilityProfile(pluginId)
      .then((value) => alive && setProfile(value))
      .catch(() => alive && setProfile(null))
    return () => {
      alive = false
    }
  }, [pluginId])

  return profile
}

/** 装前目录视图：manifest + 空授权集 → pending 文案（marketplace 未安装插件）。 */
export function useCatalogCapabilityProfile(
  manifest: PluginManifest | undefined,
  skip: boolean
): PluginCapabilityProfile | null {
  const [profile, setProfile] = useState<PluginCapabilityProfile | null>(null)

  useEffect(() => {
    if (!manifest || skip) {
      setProfile(null)
      return
    }
    let alive = true
    void previewPluginCapabilityProfile(manifest)
      .then((value) => alive && setProfile(value))
      .catch(() => alive && setProfile(null))
    return () => {
      alive = false
    }
  }, [manifest, skip])

  return profile
}
