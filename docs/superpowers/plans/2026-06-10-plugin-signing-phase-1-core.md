# Plugin Signing — Phase 1 (pure core `@synapse/plugin-signing`) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the pure, dependency-free signing/verification core that both the Synapse host and the plugin CLI will share — `canonicalJson`, path normalization + collision detection, key fingerprinting, manifest signing, and `verifyPackageSignature`.

**Architecture:** A new workspace package `@synapse/plugin-signing` (pure TS, only `node:crypto` + `node:fs`/`node:path`, **no Electron, no other deps**). Ed25519 signatures over a canonical-JSON payload; the signed manifest lives at `META-INF/synapse-signature.json` inside the `.syn`. This phase is the single source of truth imported later by the host (Phase 3) and CLI (Phase 4). Spec: `docs/superpowers/specs/2026-06-10-plugin-signing-verification-design.md` (§3–§7, §13).

**Tech Stack:** TypeScript 5 (strict), Node `crypto` (Ed25519, SPKI/PKCS8, sha256), Vitest. Build mirrors `@synapse/plugin-manifest` (`tsc -p tsconfig.build.json`).

---

### Task 1: Scaffold the `@synapse/plugin-signing` package

**Files:**
- Create: `packages/plugin-signing/package.json`
- Create: `packages/plugin-signing/tsconfig.json`
- Create: `packages/plugin-signing/tsconfig.build.json`
- Create: `packages/plugin-signing/src/index.ts` (temporary placeholder)
- Modify: `package.json` (root scripts: `build:signing`, `build:packages`, `typecheck`)

- [ ] **Step 1: Create `packages/plugin-signing/package.json`**

```json
{
  "name": "@synapse/plugin-signing",
  "version": "0.1.0",
  "description": "Synapse plugin package signing & verification core (Ed25519) — shared by the host and the plugin CLI",
  "license": "MIT",
  "sideEffects": false,
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    }
  },
  "main": "./dist/index.js",
  "types": "./dist/index.d.ts",
  "files": ["README.md", "dist", "src"],
  "scripts": {
    "build": "tsc -p tsconfig.build.json",
    "typecheck": "tsc -p tsconfig.json --noEmit"
  },
  "publishConfig": { "access": "public" }
}
```

- [ ] **Step 2: Create `packages/plugin-signing/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "CommonJS",
    "moduleResolution": "node",
    "strict": true,
    "noImplicitOverride": true,
    "noUncheckedIndexedAccess": true,
    "declaration": true,
    "declarationMap": true,
    "noEmit": true,
    "outDir": "dist",
    "sourceMap": true,
    "esModuleInterop": true,
    "forceConsistentCasingInFileNames": true,
    "isolatedModules": true,
    "skipLibCheck": true,
    "types": ["node"]
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Create `packages/plugin-signing/tsconfig.build.json`**

```json
{
  "extends": "./tsconfig.json",
  "compilerOptions": {
    "paths": {},
    "declaration": true,
    "declarationMap": true,
    "emitDeclarationOnly": false,
    "noEmit": false,
    "outDir": "dist",
    "sourceMap": false
  },
  "include": ["src/**/*"],
  "exclude": ["src/**/*.test.ts", "dist", "node_modules"]
}
```

- [ ] **Step 4: Create placeholder `packages/plugin-signing/src/index.ts`**

```ts
export const PLUGIN_SIGNING_FORMAT = 1 as const
```

- [ ] **Step 5: Wire into root `package.json` scripts**

In the root `package.json` `scripts`, change `build:packages` and `typecheck`, and add `build:signing`:

```jsonc
"build:signing": "pnpm -F @synapse/plugin-signing build",
"build:packages": "pnpm build:sdk && pnpm build:manifest && pnpm build:signing",
// in "typecheck", add this segment after the plugin-manifest typecheck:
//   ... && pnpm -F @synapse/plugin-signing typecheck && ...
```

The full `typecheck` becomes (insert `pnpm -F @synapse/plugin-signing typecheck &&` right after the `@synapse/plugin-manifest typecheck` segment):

```
"typecheck": "pnpm build:packages && pnpm -F @synapse/plugin-sdk typecheck && pnpm -F @synapse/plugin-manifest typecheck && pnpm -F @synapse/plugin-signing typecheck && pnpm -F @synapse/plugin-cli typecheck && pnpm -F create-synapse-plugin typecheck && tsc -p tsconfig.node.json --noEmit && tsc -p tsconfig.web.json --noEmit"
```

- [ ] **Step 6: Install workspace + build the new package**

Run: `pnpm install && pnpm -F @synapse/plugin-signing build`
Expected: install links the new package; build emits `packages/plugin-signing/dist/index.js` + `index.d.ts` with no errors.

- [ ] **Step 7: Commit**

```bash
git add packages/plugin-signing package.json pnpm-lock.yaml
git commit -m "build(plugin-signing): scaffold the shared signing package"
```

---

### Task 2: Shared types

**Files:**
- Create: `packages/plugin-signing/src/types.ts`

- [ ] **Step 1: Write `packages/plugin-signing/src/types.ts`** (no test — type-only declarations consumed by later tasks)

```ts
/** Path of the embedded signature entry, relative to the package root. */
export const SIGNATURE_ENTRY = "META-INF/synapse-signature.json"

/** The signed manifest embedded in a `.syn`. `signature` is NOT covered by itself. */
export interface SignatureManifest {
  format: 1
  publisherId: string
  publisherName?: string
  /** base64(SPKI DER) Ed25519 public key. */
  publicKey: string
  alg: "ed25519"
  /** package-relative POSIX path -> "sha256-<base64>" digest. */
  files: Record<string, string>
  /** base64 Ed25519 signature over canonicalJson of the payload (all fields except this). */
  signature: string
}

export type VerificationResult =
  | { status: "valid"; publisherId: string; publicKey: string; fingerprint: string }
  | { status: "unsigned" }
  | { status: "invalid"; reason: string }
```

- [ ] **Step 2: Commit**

```bash
git add packages/plugin-signing/src/types.ts
git commit -m "feat(plugin-signing): add signature manifest and result types"
```

---

### Task 3: `canonicalJson`

**Files:**
- Create: `packages/plugin-signing/src/canonical-json.ts`
- Test: `packages/plugin-signing/src/canonical-json.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest"
import { canonicalJson } from "./canonical-json"

describe("canonicalJson", () => {
  it("sorts object keys regardless of insertion order", () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
    expect(canonicalJson({ a: 2, b: 1 })).toBe('{"a":2,"b":1}')
  })

  it("recurses into nested objects and preserves array order", () => {
    expect(canonicalJson({ files: { "b.js": "y", "a.js": "x" }, arr: [3, 1, 2] })).toBe(
      '{"arr":[3,1,2],"files":{"a.js":"x","b.js":"y"}}'
    )
  })

  it("rejects non-ASCII object keys", () => {
    expect(() => canonicalJson({ "café": 1 })).toThrow(/non-ASCII key/)
  })

  it("rejects undefined, NaN, and Infinity", () => {
    expect(() => canonicalJson({ a: undefined })).toThrow(/undefined/)
    expect(() => canonicalJson(Number.NaN)).toThrow(/non-finite/)
    expect(() => canonicalJson(Number.POSITIVE_INFINITY)).toThrow(/non-finite/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test packages/plugin-signing/src/canonical-json.test.ts`
Expected: FAIL — `canonicalJson` not exported / module missing.

- [ ] **Step 3: Write minimal implementation**

```ts
// Deterministic JSON for signing: keys sorted, ASCII-only keys (so JS UTF-16
// order equals code-point order), no undefined/NaN/Infinity. Strings use
// standard JSON escaping. See spec §5.
export function canonicalJson(value: unknown): string {
  if (value === null) return "null"
  if (typeof value === "boolean" || typeof value === "string") return JSON.stringify(value)
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new Error("canonicalJson: non-finite number")
    return JSON.stringify(value)
  }
  if (typeof value === "undefined") throw new Error("canonicalJson: undefined not allowed")
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`
  if (typeof value === "object") {
    const obj = value as Record<string, unknown>
    const keys = Object.keys(obj).sort()
    const parts = keys.map((key) => {
      if (/[^\x20-\x7E]/.test(key)) throw new Error(`canonicalJson: non-ASCII key: ${key}`)
      if (typeof obj[key] === "undefined") throw new Error("canonicalJson: undefined not allowed")
      return `${JSON.stringify(key)}:${canonicalJson(obj[key])}`
    })
    return `{${parts.join(",")}}`
  }
  throw new Error(`canonicalJson: unsupported type ${typeof value}`)
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test packages/plugin-signing/src/canonical-json.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/plugin-signing/src/canonical-json.ts packages/plugin-signing/src/canonical-json.test.ts
git commit -m "feat(plugin-signing): add deterministic canonical JSON"
```

---

### Task 4: Path normalization + collision detection

**Files:**
- Create: `packages/plugin-signing/src/entry-path.ts`
- Test: `packages/plugin-signing/src/entry-path.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { describe, expect, it } from "vitest"
import { findPathCollision, normalizePackageEntryName } from "./entry-path"

describe("normalizePackageEntryName", () => {
  it("accepts and canonicalizes safe relative paths", () => {
    expect(normalizePackageEntryName("manifest.json")).toBe("manifest.json")
    expect(normalizePackageEntryName("dist/index.js")).toBe("dist/index.js")
  })

  it("rejects traversal, absolute, drive, backslash, NUL, non-ASCII, dir entries", () => {
    for (const bad of [
      "../evil.js",
      "/abs/path.js",
      "C:\\windows\\x",
      "foo\\bar",
      "foo/../bar",
      "with nul",
      "café/x.js",
      "dist/",
      "",
    ]) {
      expect(normalizePackageEntryName(bad)).toBeNull()
    }
  })
})

describe("findPathCollision", () => {
  it("returns null for distinct paths", () => {
    expect(findPathCollision(["a.js", "dir/b.js"])).toBeNull()
  })

  it("detects exact duplicates", () => {
    expect(findPathCollision(["a.js", "a.js"])).toMatch(/duplicate/)
  })

  it("detects case-folded collisions", () => {
    expect(findPathCollision(["dist/index.js", "dist/INDEX.js"])).toMatch(/case/)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test packages/plugin-signing/src/entry-path.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Write minimal implementation**

```ts
// Package-relative POSIX path safety (spec §6). Returns the canonical path or
// null when unsafe. Used for `files` manifest keys and (Phase 2) ZIP entry names.
export function normalizePackageEntryName(name: string): string | null {
  if (!name || name.includes("\0")) return null
  if (/[^\x20-\x7E]/.test(name)) return null // non-ASCII / control
  if (name.includes("\\")) return null // backslash (Windows separator)
  if (/^[a-z]:/i.test(name)) return null // drive letter
  const collapsed = name.replace(/\/+/g, "/")
  if (collapsed.startsWith("/")) return null // absolute
  if (collapsed.endsWith("/")) return null // directory entry
  const parts = collapsed.split("/")
  if (parts.some((part) => part === "" || part === "." || part === "..")) return null
  return parts.join("/")
}

// Returns a reason string for the first duplicate or case-folded collision in a
// set of already-normalized paths, or null when there are none (spec §6.2).
export function findPathCollision(paths: string[]): string | null {
  const seen = new Set<string>()
  const folded = new Map<string, string>()
  for (const path of paths) {
    if (seen.has(path)) return `duplicate path: ${path}`
    const lower = path.toLowerCase()
    const prior = folded.get(lower)
    if (prior !== undefined) return `case-folded collision: ${prior} vs ${path}`
    seen.add(path)
    folded.set(lower, path)
  }
  return null
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test packages/plugin-signing/src/entry-path.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/plugin-signing/src/entry-path.ts packages/plugin-signing/src/entry-path.test.ts
git commit -m "feat(plugin-signing): add entry-path normalization and collision detection"
```

---

### Task 5: Key encoding + fingerprint

**Files:**
- Create: `packages/plugin-signing/src/keys.ts`
- Test: `packages/plugin-signing/src/keys.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { generateKeyPairSync } from "node:crypto"
import { describe, expect, it } from "vitest"
import { fingerprint, publicKeyToBase64 } from "./keys"

describe("keys", () => {
  it("encodes a public key as base64(SPKI DER) and fingerprints it stably", () => {
    const { publicKey } = generateKeyPairSync("ed25519")
    const b64 = publicKeyToBase64(publicKey)
    expect(b64).toMatch(/^[A-Za-z0-9+/]+=*$/)

    const fp1 = fingerprint(b64)
    const fp2 = fingerprint(b64)
    expect(fp1).toMatch(/^[0-9a-f]{64}$/)
    expect(fp1).toBe(fp2) // stable, deterministic
  })

  it("gives different fingerprints for different keys", () => {
    const a = publicKeyToBase64(generateKeyPairSync("ed25519").publicKey)
    const b = publicKeyToBase64(generateKeyPairSync("ed25519").publicKey)
    expect(fingerprint(a)).not.toBe(fingerprint(b))
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test packages/plugin-signing/src/keys.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Write minimal implementation**

```ts
import type { KeyObject } from "node:crypto"
import { createHash, createPublicKey } from "node:crypto"

// Public keys are always carried as base64(SPKI DER); the fingerprint is the
// sha256 of those DER bytes, lowercase hex. Never mix PEM/DER (spec §3).
export function publicKeyToBase64(key: KeyObject): string {
  return key.export({ type: "spki", format: "der" }).toString("base64")
}

/** Reconstruct a verifiable public KeyObject from base64(SPKI DER). */
export function publicKeyFromBase64(base64: string): KeyObject {
  return createPublicKey({ key: Buffer.from(base64, "base64"), type: "spki", format: "der" })
}

export function fingerprint(publicKeyBase64: string): string {
  return createHash("sha256").update(Buffer.from(publicKeyBase64, "base64")).digest("hex")
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test packages/plugin-signing/src/keys.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/plugin-signing/src/keys.ts packages/plugin-signing/src/keys.test.ts
git commit -m "feat(plugin-signing): add public-key encoding and fingerprint"
```

---

### Task 6: Build + sign the manifest

**Files:**
- Create: `packages/plugin-signing/src/sign.ts`
- Test: `packages/plugin-signing/src/sign.test.ts`

- [ ] **Step 1: Write the failing test**

```ts
import { generateKeyPairSync, sign as nodeSign, verify as nodeVerify } from "node:crypto"
import { describe, expect, it } from "vitest"
import { canonicalJson } from "./canonical-json"
import { publicKeyFromBase64, publicKeyToBase64 } from "./keys"
import { buildSignedPayload, signManifest } from "./sign"

describe("signManifest", () => {
  it("produces a manifest whose signature verifies against the canonical payload", () => {
    const { publicKey, privateKey } = generateKeyPairSync("ed25519")
    const input = {
      publisherId: "com.acme",
      publisherName: "Acme",
      publicKeyBase64: publicKeyToBase64(publicKey),
      files: { "manifest.json": "sha256-abc", "dist/index.js": "sha256-def" },
    }

    const manifest = signManifest(input, privateKey)
    expect(manifest).toMatchObject({ format: 1, alg: "ed25519", publisherId: "com.acme" })

    const { signature, ...payload } = manifest
    const ok = nodeSign(null, Buffer.from(canonicalJson(payload), "utf8"), privateKey)
    expect(signature).toBe(ok.toString("base64"))
    expect(payload).toEqual(buildSignedPayload(input))
    // sanity: real verify path accepts it
    const verified = nodeVerify(
      null,
      Buffer.from(canonicalJson(payload), "utf8"),
      publicKeyFromBase64(input.publicKeyBase64),
      Buffer.from(signature, "base64")
    )
    expect(verified).toBe(true)
  })

  it("omits publisherName from the payload when not provided", () => {
    expect(
      buildSignedPayload({ publisherId: "x", publicKeyBase64: "k", files: {} })
    ).not.toHaveProperty("publisherName")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test packages/plugin-signing/src/sign.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Write minimal implementation**

```ts
import type { KeyObject } from "node:crypto"
import type { SignatureManifest } from "./types"
import { sign as nodeSign } from "node:crypto"
import { canonicalJson } from "./canonical-json"

export interface SignInput {
  publisherId: string
  publisherName?: string
  /** base64(SPKI DER). */
  publicKeyBase64: string
  /** path -> "sha256-<base64>". */
  files: Record<string, string>
}

/** The object the signature covers — every trust-relevant field except `signature`. */
export function buildSignedPayload(input: SignInput): Omit<SignatureManifest, "signature"> {
  const payload: Omit<SignatureManifest, "signature"> = {
    format: 1,
    publisherId: input.publisherId,
    publicKey: input.publicKeyBase64,
    alg: "ed25519",
    files: input.files,
  }
  if (input.publisherName) payload.publisherName = input.publisherName
  return payload
}

export function signManifest(input: SignInput, privateKey: KeyObject): SignatureManifest {
  const payload = buildSignedPayload(input)
  const signature = nodeSign(null, Buffer.from(canonicalJson(payload), "utf8"), privateKey)
  return { ...payload, signature: signature.toString("base64") }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test packages/plugin-signing/src/sign.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/plugin-signing/src/sign.ts packages/plugin-signing/src/sign.test.ts
git commit -m "feat(plugin-signing): build and sign the signature manifest"
```

---

### Task 7: `verifyPackageSignature`

**Files:**
- Create: `packages/plugin-signing/src/verify.ts`
- Test: `packages/plugin-signing/src/verify.test.ts`

This reads a staging directory (already-extracted package). It performs the fixed order from spec §7: read+parse (strict) → pin (`alg`/`sha256-`) → verify signature → normalize+collision `files` keys → file-set equality + per-file `lstat`(regular only)+hash.

- [ ] **Step 1: Write the failing test**

```ts
import { generateKeyPairSync } from "node:crypto"
import { promises as fs } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { createHash } from "node:crypto"
import { publicKeyToBase64 } from "./keys"
import { signManifest } from "./sign"
import { SIGNATURE_ENTRY } from "./types"
import { verifyPackageSignature } from "./verify"

let dir: string
beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(os.tmpdir(), "sig-"))
})
afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true })
})

function digest(content: string): string {
  return `sha256-${createHash("sha256").update(content).digest("base64")}`
}

async function writeFile(rel: string, content: string): Promise<void> {
  const target = path.join(dir, rel)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await fs.writeFile(target, content)
}

// Write payload files + a valid signature manifest. Returns the keypair.
async function writeSignedPackage(files: Record<string, string>, publisherId = "com.acme") {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519")
  for (const [rel, content] of Object.entries(files)) await writeFile(rel, content)
  const manifest = signManifest(
    {
      publisherId,
      publicKeyBase64: publicKeyToBase64(publicKey),
      files: Object.fromEntries(Object.entries(files).map(([k, v]) => [k, digest(v)])),
    },
    privateKey
  )
  await writeFile(SIGNATURE_ENTRY, JSON.stringify(manifest))
  return { publicKey, privateKey, manifest }
}

describe("verifyPackageSignature", () => {
  it("returns unsigned when the signature entry is missing", async () => {
    await writeFile("manifest.json", "{}")
    expect(await verifyPackageSignature(dir)).toEqual({ status: "unsigned" })
  })

  it("validates a correctly signed package", async () => {
    await writeSignedPackage({ "manifest.json": "{}", "dist/index.js": "console.log(1)" })
    const result = await verifyPackageSignature(dir)
    expect(result.status).toBe("valid")
    if (result.status === "valid") expect(result.publisherId).toBe("com.acme")
  })

  it("rejects a tampered file (hash mismatch)", async () => {
    await writeSignedPackage({ "manifest.json": "{}", "dist/index.js": "console.log(1)" })
    await writeFile("dist/index.js", "console.log(2)") // tamper after signing
    expect((await verifyPackageSignature(dir)).status).toBe("invalid")
  })

  it("rejects an extra unsigned file not in the manifest", async () => {
    await writeSignedPackage({ "manifest.json": "{}" })
    await writeFile("extra.js", "smuggled")
    expect((await verifyPackageSignature(dir)).status).toBe("invalid")
  })

  it("rejects a missing file that the manifest lists", async () => {
    await writeSignedPackage({ "manifest.json": "{}", "gone.js": "x" })
    await fs.rm(path.join(dir, "gone.js"))
    expect((await verifyPackageSignature(dir)).status).toBe("invalid")
  })

  it("rejects an unknown alg, bad hash prefix, and unknown top-level field", async () => {
    const { manifest } = await writeSignedPackage({ "manifest.json": "{}" })
    // unknown field
    await writeFile(SIGNATURE_ENTRY, JSON.stringify({ ...manifest, trusted: true }))
    expect((await verifyPackageSignature(dir)).status).toBe("invalid")
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm test packages/plugin-signing/src/verify.test.ts`
Expected: FAIL — module missing.

- [ ] **Step 3: Write minimal implementation**

```ts
import type { VerificationResult } from "./types"
import { createHash, verify as nodeVerify } from "node:crypto"
import { promises as fs } from "node:fs"
import * as path from "node:path"
import { canonicalJson } from "./canonical-json"
import { findPathCollision, normalizePackageEntryName } from "./entry-path"
import { fingerprint, publicKeyFromBase64 } from "./keys"
import { SIGNATURE_ENTRY } from "./types"

const ALLOWED_KEYS = new Set([
  "format",
  "publisherId",
  "publisherName",
  "publicKey",
  "alg",
  "files",
  "signature",
])

function invalid(reason: string): VerificationResult {
  return { status: "invalid", reason }
}

export async function verifyPackageSignature(stagingDir: string): Promise<VerificationResult> {
  // 1. Read the signature entry; absent → unsigned.
  let raw: string
  try {
    raw = await fs.readFile(path.join(stagingDir, SIGNATURE_ENTRY), "utf-8")
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return { status: "unsigned" }
    return invalid("cannot read signature file")
  }

  let m: Record<string, unknown>
  try {
    m = JSON.parse(raw) as Record<string, unknown>
  } catch {
    return invalid("signature file is not valid JSON")
  }
  // strict schema: no unknown top-level fields, correct shapes
  if (!m || typeof m !== "object" || Array.isArray(m)) return invalid("signature must be an object")
  for (const key of Object.keys(m)) if (!ALLOWED_KEYS.has(key)) return invalid(`unknown field: ${key}`)
  if (m.format !== 1) return invalid("unsupported format")
  if (typeof m.publisherId !== "string" || !m.publisherId) return invalid("bad publisherId")
  if (m.publisherName !== undefined && typeof m.publisherName !== "string")
    return invalid("bad publisherName")
  if (typeof m.publicKey !== "string" || !m.publicKey) return invalid("bad publicKey")
  if (m.alg !== "ed25519") return invalid("unsupported alg") // 2. pin alg
  if (typeof m.signature !== "string" || !m.signature) return invalid("bad signature")
  if (!m.files || typeof m.files !== "object" || Array.isArray(m.files)) return invalid("bad files")
  const files = m.files as Record<string, unknown>
  for (const [k, v] of Object.entries(files)) {
    if (typeof v !== "string" || !v.startsWith("sha256-")) return invalid(`bad digest for ${k}`) // pin hash
  }

  // 3. Verify the signature over the canonical payload (everything but `signature`).
  const { signature, ...payload } = m
  let signatureOk = false
  try {
    signatureOk = nodeVerify(
      null,
      Buffer.from(canonicalJson(payload), "utf8"),
      publicKeyFromBase64(m.publicKey),
      Buffer.from(signature as string, "base64")
    )
  } catch {
    return invalid("signature verification threw")
  }
  if (!signatureOk) return invalid("signature does not verify")

  // 4. `files` keys must be canonical, not the signature file, no collisions.
  const keys = Object.keys(files)
  for (const key of keys) {
    if (key === SIGNATURE_ENTRY) return invalid("files must not include the signature entry")
    if (normalizePackageEntryName(key) !== key) return invalid(`non-canonical path: ${key}`)
  }
  const collision = findPathCollision(keys)
  if (collision) return invalid(collision)

  // 5. File-set equality + per-file regular-file check + hash compare.
  const actual = await listRegularFiles(stagingDir)
  if (actual === null) return invalid("package contains a non-regular file")
  const actualSet = new Set(actual.filter((rel) => rel !== SIGNATURE_ENTRY))
  if (actualSet.size !== keys.length) return invalid("file set does not match manifest")
  for (const key of keys) {
    if (!actualSet.has(key)) return invalid(`missing file: ${key}`)
    const buf = await fs.readFile(path.join(stagingDir, key))
    const digest = `sha256-${createHash("sha256").update(buf).digest("base64")}`
    if (digest !== files[key]) return invalid(`hash mismatch: ${key}`)
  }

  // 6. Trusted fields (all signature-covered).
  return {
    status: "valid",
    publisherId: m.publisherId,
    publicKey: m.publicKey,
    fingerprint: fingerprint(m.publicKey),
  }
}

// Recursively list regular files as package-relative POSIX paths. Returns null
// if any non-regular file (symlink, device, fifo) is encountered (lstat, no follow).
async function listRegularFiles(root: string): Promise<string[] | null> {
  const out: string[] = []
  async function walk(dir: string, prefix: string): Promise<boolean> {
    const entries = await fs.readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      const abs = path.join(dir, entry.name)
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name
      const stat = await fs.lstat(abs)
      if (stat.isSymbolicLink() || stat.isFIFO() || stat.isCharacterDevice() || stat.isBlockDevice())
        return false
      if (stat.isDirectory()) {
        if (!(await walk(abs, rel))) return false
      } else if (stat.isFile()) {
        out.push(rel)
      } else {
        return false
      }
    }
    return true
  }
  return (await walk(root, "")) ? out : null
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `pnpm test packages/plugin-signing/src/verify.test.ts`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/plugin-signing/src/verify.ts packages/plugin-signing/src/verify.test.ts
git commit -m "feat(plugin-signing): add verifyPackageSignature core"
```

---

### Task 8: Public exports + full-gate verification

**Files:**
- Modify: `packages/plugin-signing/src/index.ts`

- [ ] **Step 1: Replace `packages/plugin-signing/src/index.ts` with the public surface**

```ts
export { canonicalJson } from "./canonical-json"
export { findPathCollision, normalizePackageEntryName } from "./entry-path"
export { fingerprint, publicKeyFromBase64, publicKeyToBase64 } from "./keys"
export { buildSignedPayload, type SignInput, signManifest } from "./sign"
export { SIGNATURE_ENTRY, type SignatureManifest, type VerificationResult } from "./types"
export { verifyPackageSignature } from "./verify"
```

- [ ] **Step 2: Run the package build + typecheck**

Run: `pnpm -F @synapse/plugin-signing build && pnpm -F @synapse/plugin-signing typecheck`
Expected: emits `dist/` with `.d.ts`; no type errors.

- [ ] **Step 3: Run the full repo gate**

Run: `pnpm typecheck && pnpm lint && pnpm test`
Expected: typecheck builds all packages (incl. plugin-signing) clean; lint clean; all tests pass (Phase 1 adds ~18 tests across the 5 modules).

- [ ] **Step 4: Commit**

```bash
git add packages/plugin-signing/src/index.ts
git commit -m "feat(plugin-signing): expose the public signing/verification surface"
```

---

## Phase 1 Done — what's next

Phase 1 delivers a standalone, fully-tested `@synapse/plugin-signing` package (the single source of truth for sign/verify). It is not yet wired into any install path. The remaining phases (each its own plan, written against these real APIs):

- **Phase 2** — Safe extraction: harden `extractSynapsePackage` to reject symlinks/special files, duplicate + case-folded paths (reusing `normalizePackageEntryName`/`findPathCollision`), `lstat` hashing.
- **Phase 3** — Host policy: `PublisherTrustStore`, `decidePluginInstall` (full matrix + global invariant), `PluginSignatureError`, wire the gate into `installPackage`/`installMarketplacePlugin`, native confirm/TOFU dialog. Adds `@synapse/plugin-signing` as a `workspace:*` dep of the app + vitest/electron-vite/tsconfig aliases.
- **Phase 4** — CLI: `keygen`/`sign`/`verify` in `@synapse/plugin-cli`; template + `SIGNING.md`.
- **Phase 5** — Backend publisher anchor (depends on the marketplace backend, PR #1): the backend serves each plugin's publisher public key in its `@synapse/marketplace-types` metadata; the desktop marketplace install reads `registryPublisher` from the backend API. No static git registry / no v1–v2 versioning — if the backend has no anchor, reject (never downgrade to unsigned).
