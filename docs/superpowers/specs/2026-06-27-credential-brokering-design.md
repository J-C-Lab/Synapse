# Credential Brokering / Identity Proxy Design

> Date: 2026-06-27
> Status: design approved in conversation (5 sections). Establishes the next
> "agent-can't-do" plugin capability axis after event-driven background
> automation shipped: letting a third-party plugin act on the user's behalf
> against an authenticated service **without the raw secret ever entering the
> plugin sandbox or the model context.**

## Context

Synapse's event-driven background automation is LIVE end-to-end (timer/cron,
fs.watch, clipboard, hotkey adapters; background invoker; admission/budget/agent
breakers; reversible `fs:write`; the downloads-organizer flagship). That axis
delivered the first capability an agent cannot replicate with shell + scripts:
**long-lived background reaction.**

This spec opens the second such axis, framed by the same test — *what can a
developer build on the scaffold that agent + shell cannot do?* The answer here
is **authenticated third-party access where the secret must never be seen by the
model.** Today a developer who wants a "connect my GitHub / Notion / company API"
plugin has only one path: stash the token in `ctx.storage` (plaintext JSON in
`userData`) and hand-assemble the `Authorization` header inside the sandbox. That
means the long-lived secret lives in plugin JS, reachable by the model through
tool results and logs. The scaffold currently *forces developers to do the
insecure thing.*

The differentiating value is precisely the security boundary: **an agent cannot
safely hold a credential it must not see.** A host-brokered credential — held by
the host, injected at the network egress, never exposed to sandbox or model — is
the one way to make this class of plugin possible. This is a permission/
capability-model problem first and a plumbing problem second.

## Goal

> A plugin can act on the user's behalf against a declared authenticated host —
> via OAuth 2.0 (Authorization Code + PKCE) or a static secret — where the
> credential is held only by the host, injected only at the SSRF-hardened network
> egress, only for the credential's bound hosts, and is never visible to the
> plugin sandbox or the model. Every connect / refresh / inject / revoke is
> scoped, consented at enable time, audited, observable, and revocable.

## Non-goals (v1)

- **Token handoff to the plugin.** The access token never enters the sandbox
  (strict injection-only). Plugins use `ctx.network.fetch`; provider SDKs that
  manage their own HTTP are out of scope by construction.
- **Multi-account per credential.** One `credentialId` binds to a single
  connected account. Multiple accounts → deferred.
- **OAuth flows other than Authorization Code + PKCE.** No device-code, no
  client-credentials, no implicit flow.
- **Custom-scheme redirect capture** (`synapse://...`). Loopback only (RFC 8252).
- **Confidential clients.** Providers requiring an embedded `client_secret` are
  rejected — a secret shipped inside a distributed plugin is not a secret.
- **Inbound/webhook triggers in general.** The loopback server is a single-use,
  seconds-long, localhost-only exception scoped to one in-flight auth handshake
  (see §4), not a reintroduction of the deferred webhook surface.

## Non-negotiable invariants (load-bearing walls)

Each of these, if relaxed, breaks the "model/plugin never sees the secret" thesis
or opens a phishing/exfiltration path. They are design ground, not options.

1. **Raw secret and refresh token never enter the sandbox, the model context, or
   logs.** Held only in the host vault.
2. **Access token also never enters the sandbox** (strict injection-only). The
   plugin only ever observes a `"connected" | "disconnected"` boolean.
3. **Injection is host-pinned.** A credential is attached to an outbound request
   only when `url.host ∈ credential.inject.hosts`, and `inject.hosts` must be a
   subset of the plugin's granted `network:https` scope. Validated at declaration
   time; enforced at the egress.
4. **Browser authorization happens only under an explicit user gesture** in host
   chrome. A plugin can mark "needs connect" but cannot open a browser or start
   an auth flow on its own.
5. **The loopback callback server is `127.0.0.1`-only, single-use, timeout-fused,
   and validates `state` (CSRF) + PKCE.** It binds to a random ephemeral port,
   accepts exactly one matching callback, then closes.

## Capability & manifest model

**New capability: `credentials:oauth`, tier `elevated`, scope-enforced.** It rides
the existing declaration → `normalizeCapabilities` → declaration-hash → grant
chain, structurally identical to `network:https`. (`type: "static"` credentials
declare the same capability; the type discriminates the connect mechanism, not
the governance.)

Manifest declaration (`contributes.credentials[]`):

```jsonc
"credentials": [
  {
    "id": "github",
    "type": "oauth2-pkce",                 // or "static"
    "label": { "en": "GitHub", "zh-CN": "GitHub 账号" },
    // oauth2-pkce only:
    "clientId": "Iv1.abc123",              // non-secret, public client
    "authorizationEndpoint": "https://github.com/login/oauth/authorize",
    "tokenEndpoint": "https://github.com/login/oauth/access_token",
    "revocationEndpoint": "https://github.com/...",   // optional, best-effort on revoke
    "scopes": ["repo", "read:user"],
    // both types:
    "inject": {
      "hosts": ["api.github.com"],         // injection allowlist (⊆ network scope)
      "scheme": "bearer"                    // "bearer" | { "header": "X-Api-Key" } | { "query": "access_token" }
    }
  }
]
```

`static` credentials omit the OAuth endpoint/scope fields; the host collects the
secret through its own secure input (see §2).

**Two governance invariants over the declaration:**

1. **`inject.hosts ⊆ granted `network:https` scope.** Otherwise the declaration
   describes a credential that could be sent to an arbitrary host. Rejected at
   registration (the `network:https` scope adapter's `contains` decides the
   subset check).
2. **Credential declarations fold into the identity fingerprint.** The existing
   fingerprint already hashes `pluginId + publisherId + signingKeyFingerprint +
   capabilityDeclarationHash`. Any change to `clientId`, endpoints, `scopes`, or
   `inject.hosts` changes the hash → prior connection grants are invalidated →
   re-consent + re-connect required. Prevents an update that widens scope from
   inheriting a previously authorized token.

**Enable-time consent** presents, as one unit: the provider/label, the requested
OAuth `scopes`, and **which hosts the credential will be sent to**. Consent is
front-loaded here (matching the network/triggers model); the connect action
itself is a separate, explicit, later user gesture.

## §1 — Component spine

All sensitive operations are pushed host-side; the sandbox sees only a boolean.
Four new host components plus an egress hook; governance/audit/revocation reuse
existing chains.

```
[user clicks Connect in host chrome]
        │
        ▼
 OAuth Flow Runner (host, NEW) ──► system browser (shell.openExternal, reuse)
        │  builds authorize URL (client_id, PKCE challenge, state, scopes)
        ▼
 Loopback Callback Server (host, NEW)  127.0.0.1:<random>/callback, single-use, timeout-fused
        │  verify state (CSRF) → exchange code + PKCE verifier at tokenEndpoint
        ▼
 Credential Vault (host, NEW)  safeStorage-encrypted {access, refresh, expiresAt, scopes}
        ▲                                   │
        │ Token Refresher (host, NEW)       │ refresh before expiry; on failure → mark disconnected
        │                                   ▼
 Credential Injector (extends network-fetcher egress, reuse) ──
        │   attach Authorization iff url.host ∈ inject.hosts AND connected
        ▲
        │ ctx.network.fetch(url)   ← the only thing a plugin can do; it never sees a token
 [warm Sandbox / plugin]  ctx.credentials.status(id) → "connected" | "disconnected"
```

Component boundaries:

- **Credential Vault** (host, new) — `safeStorage`-encrypted per-plugin store at
  `userData/plugin-credentials/<pluginId>/<credentialId>` holding
  `{ type, accessToken?, refreshToken?, secret?, expiresAt?, scopes? }`. Only the
  host reads it; reuses the atomic-JSON-store write discipline used by the grant
  store, wrapped in `safeStorage.encryptString` / `decryptString`.
- **OAuth Flow Runner** (host, new) — owns the Authorization Code + PKCE
  handshake: generate `code_verifier`/`code_challenge` + `state`, build the
  authorize URL, drive the loopback server, exchange the code, persist tokens.
- **Loopback Callback Server** (host, new) — ephemeral `127.0.0.1:<random>` HTTP
  server, one route (`/callback`), accepts exactly one callback whose `state`
  matches the pending flow, then closes; a timeout (default 5 min) fuses it shut
  and fails the flow.
- **Token Refresher** (host, new) — schedules a refresh before `expiresAt`; on
  refresh failure marks the credential `disconnected` (never degrades to an
  unauthenticated request).
- **Credential Injector** (extends `network-fetcher`) — at the existing single
  egress, before bytes leave: if the request's host ∈ `inject.hosts` and the
  credential is connected, attach the credential per `inject.scheme`; otherwise
  leave the request untouched (ordinary scoped fetch). Reuses the SSRF/redirect/
  size guards already at that chokepoint.

## §2 — Runtime flow

**Connect (by type):**

- `static`: user clicks Connect in host chrome → host renders a **secure input**
  (host-owned; the plugin JS is never in the loop) → secret written to vault.
- `oauth2-pkce`: user clicks Connect → Flow Runner mints `code_verifier` /
  `code_challenge` + `state`, starts the loopback server, `shell.openExternal`
  the authorize URL → user authorizes in the system browser → callback hits
  loopback → verify `state` → exchange `code` + `verifier` at `tokenEndpoint` →
  persist tokens → close loopback. **Timeout or `state` mismatch fuses the server
  and fails the flow.**

**Call injection (unified for both types):** plugin calls
`ctx.network.fetch(url)` → egress checks `url.host ∈ inject.hosts` and credential
`connected` → host attaches `Authorization` (bearer / custom header / query, per
`inject.scheme`) → request proceeds. A non-matching host is **not** injected.

**Refresh / reconnect (oauth only):** the Refresher refreshes before `expiresAt`.
On refresh failure (token revoked/expired) → mark `disconnected` → the plugin's
next `fetch` throws a typed `CredentialNotConnectedError`, and the host surfaces a
Reconnect prompt in the panel. Refresh failure **never** becomes a silent
unauthenticated request.

## §3 — SDK surface

`ctx.credentials` — deliberately minimal, with **no token getter of any kind**:

```ts
interface CredentialsAPI {
  /** Whether a declared credential currently has a usable connection. No token. */
  status: (id: string) => Promise<"connected" | "disconnected">
  /** Mark the credential as needing connection; the host surfaces a Connect
   *  button. Does NOT open a browser or start a flow (invariant 4). */
  requestConnect: (id: string) => Promise<void>
}
```

The plugin's entire credential surface is these two methods plus
`ctx.network.fetch` (auto-injected). `network.ts` types are unchanged — injection
is transparent to the plugin. A new typed error `CredentialNotConnectedError` is
thrown by `fetch` when a request targets an `inject.hosts` host whose credential
is disconnected.

## §4 — Loopback exception rationale (vs the deferred webhook surface)

The triggers spec deferred inbound HTTP. The loopback callback server is a
bounded exception, not a reversal of that decision, because it is: bound to
`127.0.0.1` only (never `0.0.0.0`); alive only for the seconds of one in-flight
handshake; single-use (one matching callback then close); timeout-fused;
gated by `state` (CSRF) + PKCE (code interception); and started only under the
same explicit user gesture that opened the browser. It exposes no plugin-reachable
endpoint and persists no listener. A persistent inbound/webhook trigger remains
out of scope.

## §5 — Observability, audit & revocation

**Audit** reuses `capability-audit`: `connect`, `refresh`, `inject`,
`reauth-needed`, `revoke` events, recording **only `credentialId` + host — never
a token value or secret** (same redaction discipline as the network audit).

**Observability** extends the existing governance UI: each declared credential
shows `connected | disconnected | needs-reconnect`, the bound hosts, last
refresh, and a Connect / Reconnect / Disconnect action.

**Revocation** = delete the vault entry + best-effort call the provider's
`revocationEndpoint` + invalidate the grant. Reuses the existing revoke UI/IPC.

## Component boundaries

- **Credential Vault** — `safeStorage`-backed encrypted KV; only host reads;
  depends on Electron `safeStorage` + atomic JSON store.
- **OAuth Flow Runner** — PKCE/state generation + token exchange; depends on the
  Loopback Server, `shell.openExternal`, and `network-fetcher` (token exchange
  goes through the same hardened egress, pinned to `tokenEndpoint`'s host).
- **Loopback Callback Server** — `node:http` on `127.0.0.1:0`; single route;
  self-closing; no plugin coupling.
- **Token Refresher** — timer-driven; depends on Vault + Flow Runner's refresh
  call.
- **Credential Injector** — a hook inside `network-fetcher`; depends on the
  `network:https` scope adapter (`contains`) for the host-pin check and on the
  Vault for the current token.
- **CredentialsAPI** (SDK + bridge) — `status` / `requestConnect`; closes over
  the host-side credential state; never carries a token.
- **Governance UI** (renderer, existing governance surface extended) — read-only
  state + connect/reconnect/disconnect/revoke over existing IPC.

## Implementation order

1. **Vault + capability registration + manifest declaration + `inject.hosts ⊆
   network scope` validation + fingerprint fold.** The permission model and
   storage, independent of any flow. Unit-testable with no OS seams.
2. **Static credential end-to-end** — secure input (host) → vault → injector at
   the egress (host-pin + scheme). Proves the injection spine without OAuth.
3. **Credential Injector hardening** — host-pin enforcement, scheme variants
   (bearer / header / query), non-matching-host pass-through, disconnected →
   `CredentialNotConnectedError`.
4. **OAuth Flow Runner + Loopback Server** — PKCE/state, single-use/timeout
   server, code exchange. Faked browser + faked provider token endpoint.
5. **Token Refresher + reconnect** — pre-expiry refresh, refresh-failure →
   disconnected, reauth surfacing.
6. **Governance UI + audit + revocation** wiring.

Each step is a thin, independently testable unit on the shared vault + egress
spine; the permission model (step 1) and the injector (steps 2–3) are built once
and reused by OAuth.

## Testing

- **Declaration governance:** `inject.hosts` not ⊆ network scope → rejected;
  changing `clientId`/endpoints/`scopes`/`inject.hosts` yields a new fingerprint
  and invalidates prior grants.
- **Injection pinning:** token attached iff `url.host ∈ inject.hosts`; a request
  to any other host (incl. an attacker host inside the broader network scope but
  outside `inject.hosts`) is never injected; scheme variants attach correctly;
  disconnected credential → `CredentialNotConnectedError`, never a silent
  unauthenticated request.
- **Vault:** secrets/tokens round-trip through `safeStorage`; the on-disk file is
  ciphertext; no token value appears in any audit record or log.
- **Sandbox isolation:** `ctx.credentials` exposes no token getter; `status`
  returns only the boolean; `requestConnect` cannot open a browser or start a
  flow (no browser side effect in the test seam).
- **OAuth flow:** loopback accepts exactly one callback with the matching
  `state`, rejects a mismatched/forged `state`, closes after one callback, and
  fuses on timeout; PKCE verifier is sent on exchange; code exchange goes through
  the hardened egress.
- **Refresh:** pre-expiry refresh succeeds and updates the vault; refresh failure
  marks disconnected and surfaces reauth; never degrades to unauthenticated.
- **Revocation:** delete vault + best-effort revocation call + grant invalidation;
  subsequent `fetch` to a bound host throws `CredentialNotConnectedError`.
- **End-to-end** (real vault + injector + grant store, faked browser/provider/OS
  seams) per the network-e2e pattern.
</content>
</invoke>
