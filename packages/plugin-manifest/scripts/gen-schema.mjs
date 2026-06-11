// Generate a JSON Schema for synapse.json from the canonical zod schema, so
// editors can offer autocomplete/validation against the SAME contract the
// host enforces at install time. Run after the TypeScript build (reads dist).
import { mkdirSync, writeFileSync } from "node:fs"
import { z } from "zod"
// Reads the built schema to derive the JSON Schema — this is a post-build step.
// eslint-disable-next-line antfu/no-import-dist
import mod from "../dist/index.js"

const SCHEMA_URL =
  "https://unpkg.com/@synapsepkg/plugin-manifest/schema/synapse-manifest.schema.json"

const jsonSchema = z.toJSONSchema(mod.manifestSchema, { target: "draft-7" })
jsonSchema.$id = SCHEMA_URL
jsonSchema.title = "Synapse Plugin Manifest"
jsonSchema.description = "Schema for a Synapse plugin's synapse.json manifest."

mkdirSync(new URL("../schema/", import.meta.url), { recursive: true })
writeFileSync(
  new URL("../schema/synapse-manifest.schema.json", import.meta.url),
  `${JSON.stringify(jsonSchema, null, 2)}\n`
)
console.log("wrote schema/synapse-manifest.schema.json")
