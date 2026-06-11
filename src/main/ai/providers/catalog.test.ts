// @vitest-environment node
import { describe, expect, it } from "vitest"
import { DEFAULT_PROVIDER_ID, defaultProviderCatalog } from "./catalog"

describe("defaultProviderCatalog", () => {
  const catalog = defaultProviderCatalog()

  it("includes Anthropic, OpenAI, and the OpenAI-compatible vendors", () => {
    expect(catalog.map((provider) => provider.id)).toEqual([
      "anthropic",
      "openai",
      "zhipu",
      "siliconflow",
      "bailian",
    ])
  })

  it("gives every provider a label, a default model, and suggested models", () => {
    for (const provider of catalog) {
      expect(provider.label.trim()).not.toBe("")
      expect(provider.defaultModel.trim()).not.toBe("")
      expect(provider.models.length).toBeGreaterThan(0)
      expect(provider.models).toContain(provider.defaultModel)
    }
  })

  it("builds a provider whose id matches its descriptor", () => {
    for (const provider of catalog) {
      expect(provider.create("test-key").id).toBe(provider.id)
    }
  })

  it("exposes a default provider that exists in the catalog", () => {
    expect(catalog.some((provider) => provider.id === DEFAULT_PROVIDER_ID)).toBe(true)
  })
})
