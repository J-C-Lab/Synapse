# Credential Brokering / Identity Proxy Design

> Date: 2026-06-27
> Status: design approved in conversation (5 sections), then hardened after one
> review round. Review amendments applied: capability renamed
> `credentials:oauth` → `credentials:broker` with a real scope adapter;
> injection pinned at host **+ method + path** (delegating to the
> `network:https` adapter), not host-only; overlapping inject scopes rejected
> in v1; vault records bound to the full plugin identity and fail-closed;
> `safeStorage` unavailability fails closed (no plaintext fallback); static
> secret entry through a main-process native/secure surface; OAuth endpoint
> validation + PKCE/state hardening; refresh failure graded (transient vs
> `invalid_grant`) with token rotation; Disconnect / Reconnect / Revoke split
> into three distinct actions; trigger `uses` must include the credential for a
> background invocation to inject. Ready for implementation plan.

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

> A plugin can act on the user's behalf against a declared, scoped authenticated
> endpoint — via OAuth 2.0 (Authorization Code + PKCE) or a static secret — where
> the credential is held only by the host, injected only at the SSRF-hardened
> network egress, only for requests inside the credential's declared host+method+
> path scope, and is never visible to the plugin sandbox or the model. Every
> connect / refresh / inject / disconnect / revoke is scoped, consented at enable
> time, audited, observable, and revocable.

## Non-goals (v1)

- **Token handoff to the plugin.** The access token never enters the sandbox
  (strict injection-only). Plugins use `ctx.network.fetch`; provider SDKs that
  manage their own HTTP are out of scope by construction.
- **Multi-account per credential.** One `credentialId` binds to a single
  connected account. Multiple accounts → deferred.
- **Overlapping inject scopes within a plugin.** Two credentials whose inject
  scopes intersect are rejected at declaration (see §2), so injection stays
  transparent (no `credentialId` in the `fetch` call).
- **Query-parameter injection.** v1 injects only via an `Authorization: Bearer`
  header or a declared custom request header. Query-string token injection is
  deferred (it leaks into URLs, logs, referrers).
- **OAuth flows other than Authorization Code + PKCE.** No device-code, no
  client-credentials, no implicit flow.
- **Custom-scheme redirect capture** (`synapse://...`). Loopback only (RFC 8252).
- **Confidential clients.** Providers requiring an embedded `client_secret` are
  rejected — a secret shipped inside a distributed plugin is not a secret.
- **Inbound/webhook triggers in general.** The loopback server is a single-use,
  seconds-long, localhost-only exception scoped to one in-flight auth handshake
  (see §5), not a reintroduction of the deferred webhook surface.
- **Plaintext credential fallback.** If OS-backed encryption is unavailable,
  Connect is refused; credentials are never written unencrypted (see §3).

## Non-negotiable invariants (load-bearing walls)

Each of these, if relaxed, breaks the "model/plugin never sees the secret" thesis
or opens a phishing/exfiltration path. They are design ground, not options.

1. **Raw secret and refresh token never enter the sandbox, the model context, or
   logs.** Held only in the host vault.
2. **Access token also never enters the sandbox** (strict injection-only). The
   plugin only ever observes a `"connected" | "disconnected" | "needs-reconnect"`
   status — never a token.
3. **Injection is scope-pinned at host + method + path.** A credential is attached
   to an outbound request only when the request's `{host, method, path}` is
   contained by `credential.inject.scope`, and `inject.scope` must itself be
   contained by the plugin's granted `network:https` scope. Both checks use the
   `network:https` scope adapter's `contains`. Validated at declaration; enforced
   at the egress on every request and every redirect hop.
4. **Browser authorization happens only under an explicit user gesture** in host
   chrome. A plugin can mark "needs connect" but cannot open a browser or start
   an auth flow on its own.
5. **The loopback callback server is `127.0.0.1`-only, single-use, timeout-fused,
   and validates `state` (CSRF) + PKCE.** It binds to a random ephemeral port,
   accepts exactly one callback whose `state` matches the pending flow, then
   closes.
6. **The vault entry is bound to the full plugin identity and fails closed.** A
   token is read/injected only if the current `pluginId + publisherId +
   signingKeyFingerprint + capabilityDeclarationHash + credentialDeclarationHash`
   exactly matches the record; any mismatch (or a corrupt/undecryptable record)
   is treated as `disconnected` and never injected.

## Capability & manifest model

**New capability: `credentials:broker`, tier `elevated`, scope-enforced, with its
own scope adapter.** It rides the existing declaration → `normalizeCapabilities` →
declaration-hash → grant chain, structurally identical to `network:https`. The
credential `type` (`oauth2-pkce` | `static`) discriminates the *connect
mechanism*, never the capability id or governance — so an audit line reading
`credentials:broker` is honest regardless of which credential type produced it.

### Credential scope adapter

The `credentials:broker` scope is the credential set plus, per credential, the
inject scope (which is itself a `network:https` scope). The adapter **delegates
all host/method/path validation, canonicalization, containment, and overlap
detection to `networkHttpsAdapter`** — it does not re-implement glob/path logic —
and owns only the `credentialId` mapping:

```ts
interface CredentialBrokerScope {
  credentialIds: string[]
  inject: Array<{
    credentialId: string
    // a network:https scope; validated/contained via networkHttpsAdapter
    scope: { hosts: string[]; methods?: string[]; paths?: string[] }
  }>
}
```

- `validate`: every `inject[].scope` must pass `networkHttpsAdapter.validate`;
  every `inject[].credentialId` must appear in `credentialIds`.
- `contains` / `merge` / `canonicalize` / `summarize`: per-credential, delegate to
  `networkHttpsAdapter` on the inject scope.
- **Overlap rejection:** for any two inject scopes in the same plugin,
  `networkHttpsAdapter.contains` in either direction (or a host/method/path
  intersection) → reject the declaration. This keeps injection transparent (§4).

### Manifest declaration

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
      "scope": {                            // host + method + path, not host-only
        "hosts": ["api.github.com"],
        "methods": ["GET", "POST"],
        "paths": ["/repos/**"]
      },
      "scheme": "bearer"                     // "bearer" | { "header": "X-Api-Key" }
    }
  }
]
```

`static` credentials omit the OAuth endpoint/scope fields; the host collects the
secret through a main-process secure surface (see §3).

**Governance invariants over the declaration:**

1. **`inject.scope ⊆ granted `network:https` scope** (host+method+path), via
   `networkHttpsAdapter.contains`. Otherwise the declaration describes a
   credential that could be sent outside the plugin's allowed network reach.
   Rejected at registration.
2. **Inject scopes within a plugin must be disjoint** (overlap rejection above).
3. **`inject.scheme` custom header is restricted.** A custom header name must not
   be a forbidden/host-controlled header (`Authorization` reserved for `bearer`;
   `Cookie`, `Host`, `Content-Length`, `Content-Type`, and other forbidden
   request headers rejected at declaration).
4. **Credential declarations fold into the identity fingerprint.** The existing
   fingerprint already hashes `pluginId + publisherId + signingKeyFingerprint +
   capabilityDeclarationHash`; add a `credentialDeclarationHash`. Any change to a
   `clientId`, endpoint, `scopes`, `inject.scope`, or `scheme` changes the hash →
   prior connection grants are invalidated → re-consent + re-connect required.
5. **OAuth endpoints are validated** (see §5): `https:` only (the loopback
   redirect is the sole exception), no userinfo, default port only, and never
   `localhost` / IP literal / private network / `.local`.

**Enable-time consent** presents, as one unit: the provider, the requested OAuth
`scopes`, and the **host+method+path the credential will be sent to**. The
authorization UI (§5) displays the **real endpoint origin + publisher identity**,
never the self-declared `label` alone, so a plugin cannot label a malicious
endpoint "GitHub". Consent is front-loaded here; the connect action itself is a
separate, explicit, later user gesture.

## §1 — Component spine

All sensitive operations are pushed host-side; the sandbox sees only a status
enum. Four new host components plus an egress hook; governance/audit/revocation
reuse existing chains.

```
[user clicks Connect in host chrome]
        │
        ▼
 OAuth Flow Runner (host, NEW) ──► system browser (shell.openExternal, reuse)
        │  builds authorize URL (client_id, PKCE S256 challenge, state, scopes)
        ▼
 Loopback Callback Server (host, NEW)  127.0.0.1:<random>/callback, single-use, timeout-fused
        │  verify state (CSRF) → exchange code + PKCE verifier at tokenEndpoint (via hardened egress)
        ▼
 Credential Vault (host, NEW)  safeStorage-encrypted, identity-bound record
        ▲                                   │
        │ Token Refresher (host, NEW)       │ refresh before expiry; graded failure handling
        │                                   ▼
 Credential Injector (extends network-fetcher egress, reuse) ──
        │   attach credential iff request {host,method,path} ⊆ inject.scope AND connected
        ▲   (re-checked on every redirect hop; plugin-set conflicting header → reject)
        │ ctx.network.fetch(url)   ← the only thing a plugin can do; it never sees a token
 [warm Sandbox / plugin]  ctx.credentials.status(id) → "connected" | "disconnected" | "needs-reconnect"
```

Component boundaries:

- **Credential Vault** (host, new) — `safeStorage`-encrypted, **identity-bound**
  per-credential record (see §3) under `userData/plugin-credentials/`. Only the
  host reads it; reuses the atomic-JSON-store write discipline used by the grant
  store, wrapped in `safeStorage.encryptString` / `decryptString`.
- **OAuth Flow Runner** (host, new) — owns Authorization Code + PKCE: generate
  `code_verifier`/`code_challenge` (S256) + `state`, build the authorize URL,
  drive the loopback server, exchange the code, persist tokens.
- **Loopback Callback Server** (host, new) — ephemeral `127.0.0.1:<random>` HTTP
  server, one route (`/callback`), accepts the single callback whose `state`
  matches the pending flow, then closes; a timeout fuses it shut.
- **Token Refresher** (host, new) — schedules a refresh before `expiresAt`,
  durable across app restart, single-flight per credential; grades failures (§4).
- **Credential Injector** (extends `network-fetcher`) — at the existing single
  egress, before bytes leave and on every redirect hop: if the request's
  `{host, method, path}` ⊆ `inject.scope` and the credential is connected, attach
  the credential per `inject.scheme`; otherwise leave the request untouched
  (ordinary scoped fetch). Reuses the SSRF/redirect/size guards already there.

## §2 — Runtime flow

**Connect (by type):**

- `static`: user clicks Connect in host chrome → host opens a **main-process
  secure input** (§3) → secret written to the identity-bound vault. The plugin JS
  is never in the loop.
- `oauth2-pkce`: user clicks Connect → Flow Runner mints `code_verifier` /
  `code_challenge` (S256) + `state`, starts the loopback server, `shell.openExternal`
  the authorize URL → user authorizes in the system browser → callback hits
  loopback → verify `state` → exchange `code` + `verifier` at `tokenEndpoint` →
  validate the token response (`token_type`, `expires_in`, granted `scope`) →
  persist tokens → close loopback. **Timeout or `state` mismatch fails the flow**
  (a mismatched `state` is rejected and counted, not silently honored; the server
  fuses on timeout or after a mismatch threshold — a stray bad-`state` probe must
  not DoS the user's login).

**Call injection (unified for both types):** plugin calls
`ctx.network.fetch(url, init)` → egress builds the requested
`{host, method, path}` and checks `networkHttpsAdapter.contains(inject.scope, req)`
and credential `connected` → host attaches the credential per `inject.scheme`. A
request outside the inject scope is **not** injected (it may still proceed as an
ordinary scoped fetch if within `network:https` scope). **If the plugin already
set the target header** (`Authorization` for `bearer`, or the custom header name),
the request is **rejected — never overwritten** — so a plugin cannot probe or
shadow the injected value. The pin is **re-evaluated on each redirect hop**; a
redirect that leaves the inject scope drops the credential.

**Refresh / reconnect (oauth only):** see §4. The plugin's `fetch` to an inject
host whose credential is not currently usable throws a typed
`CredentialNotConnectedError`; refresh failure **never** becomes a silent
unauthenticated request.

## §3 — Vault: identity binding, encryption, secure entry

**Record shape (encrypted at rest):**

```ts
interface VaultRecord {
  pluginId: string
  publisherId: string
  signingKeyFingerprint: string
  capabilityDeclarationHash: string
  credentialDeclarationHash: string
  credentialId: string
  type: "oauth2-pkce" | "static"
  connectedAt: number
  tokenSet: {              // oauth2-pkce
    accessToken: string
    refreshToken?: string
    expiresAt?: number
    grantedScopes?: string[]
  } | { secret: string }   // static
}
```

**Read = verify identity first (invariant 6).** Before any injection the host
recomputes the current identity tuple and compares all five fields; on any
mismatch the record is treated as `disconnected` and ignored (grant invalidation
is enforced by the vault itself, not only by the grant store). A record that fails
to decrypt or parse is also treated as `disconnected` (fail-closed), surfaced as
`needs-reconnect`.

**Encryption is mandatory.** All reads/writes go through
`safeStorage.encryptString` / `decryptString`. If
`safeStorage.isEncryptionAvailable()` is false (no OS keychain / DPAPI / Linux
secret service): Connect is **refused**, the UI shows "system secure storage
unavailable — credentials cannot be saved", **no vault file is written**, and
there is **no plaintext fallback**. (Any future degradation must be an in-memory,
session-only credential that never touches `userData` and dies on app exit.)

**Static secret entry is a main-process secure surface**, mirroring the signing
spec's native-`dialog` discipline for security-critical input (which deliberately
shows publisher identity over self-declared name). The secret is collected by a
host-owned surface (native `dialog`/prompt or a dedicated secure `BrowserWindow`
with `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`) — **not**
a plugin view/iframe — and is never placed in renderer state, Redux/Zustand
stores, devtools-visible state, or logs. It goes straight to `safeStorage` →
vault.

## §4 — Token lifecycle (oauth)

**Refresh is graded, not binary:**

| Outcome | Action |
| --- | --- |
| Provider `invalid_grant` / explicit revoke | `disconnected` immediately; surface Reconnect |
| Transient (network/DNS error, 5xx, timeout) | `degraded` / retry with exponential backoff; keep using the existing access token while it is unexpired |
| Access token expired AND refresh still failing | `needs-reconnect` |

**Refresh-token rotation is atomic.** If the provider returns a new
`refresh_token`, it replaces the old one only after the new token set is durably
written; if the vault write fails, the **old refresh token is retained** (never
dropped on a failed rotation). Refresh is **single-flight per credential** (one
in-flight refresh; concurrent callers await it) and the schedule is **durable
across app restart** (re-armed from `expiresAt` on startup).

## §5 — OAuth endpoint validation & loopback rationale

**Endpoint validation (declaration + per-request).** `authorizationEndpoint`,
`tokenEndpoint`, `revocationEndpoint` must be `https:` (the loopback redirect URI
is the only `http:` exception), carry no userinfo, use the default port, and must
never resolve to `localhost` / an IP literal / a private network / `.local`. The
token / refresh / revoke HTTP calls go through the hardened `network-fetcher`
egress (DNS resolution + public-IP validation + connection pinning), exactly like
plugin fetches.

**PKCE / state hardening.** `code_challenge_method = S256` only; `code_verifier`
≥ 32 bytes of CSPRNG entropy; `state` ≥ 128 bits of entropy, bound to
`pluginId + credentialId + flowId + redirectUri`; at most one in-flight flow per
credential; the callback validates method + path + `state`; the token response is
validated (`token_type`, `expires_in`, granted `scope`).

**Loopback exception vs the deferred webhook surface.** The triggers spec deferred
inbound HTTP. The loopback callback server is a bounded exception, not a reversal:
bound to `127.0.0.1` only (never `0.0.0.0`); alive only for the seconds of one
in-flight handshake; single-use; timeout-fused; gated by `state` + PKCE; started
only under the explicit user gesture that opened the browser. It exposes no
plugin-reachable endpoint and persists no listener.

## §6 — SDK surface

`ctx.credentials` — deliberately minimal, with **no token getter of any kind**:

```ts
interface CredentialsAPI {
  /** Status of a declared credential. Never a token. */
  status: (id: string) => Promise<"connected" | "disconnected" | "needs-reconnect">
  /** Mark the credential as needing connection; the host surfaces a Connect
   *  button. Does NOT open a browser or start a flow (invariant 4). */
  requestConnect: (id: string) => Promise<void>
}
```

The plugin's entire credential surface is these two methods plus
`ctx.network.fetch` (auto-injected). `network.ts` types are unchanged — injection
is transparent. A new typed error `CredentialNotConnectedError` is thrown by
`fetch` when a request lands in an `inject.scope` whose credential is not usable.

## §7 — Triggers / background alignment

A background (trigger-originated) invocation that triggers credential injection
must be authorized for it. Per the triggers model, a handler may only use
capabilities listed in its trigger's `uses`; injection silently riding on a
`network:https` use would let a background task carry the user's credential
without that being visible in the trigger's declared surface.

**Rule:** a trigger-origin `ctx.network.fetch` injects a credential only if the
trigger's `uses` includes a `credentials:broker` entry whose scope covers that
credential; otherwise the credential is **not injected** (and, if the request
depended on it, fails closed). The credential use carries its own budget like any
other:

```jsonc
"uses": [
  { "capability": "network:https",     "scope": { "hosts": ["api.github.com"], "paths": ["/repos/**"] }, "budget": { "maxCalls": 10, "period": "1h" } },
  { "capability": "credentials:broker", "scope": { "credentialIds": ["github"] },                        "budget": { "maxCalls": 10, "period": "1h" } }
]
```

This keeps the Active Background panel honest: "this task reaches api.github.com"
*and* "it carries your GitHub credential" are both visible and both budgeted.

## §8 — Observability, audit & revocation

**Three distinct actions** (must not be collapsed):

| Action | Effect |
| --- | --- |
| **Disconnect account** | best-effort provider revoke (read token into memory *before* deleting), delete vault entry; **capability grant retained** → user can Reconnect |
| **Reconnect** | re-run the connect flow, write a fresh identity-bound vault record |
| **Revoke capability** | delete vault entry + tombstone/invalidate the grant; re-enable/consent required to use again |

The panel's "Disconnect" (swap accounts) and governance "Revoke" (remove the
capability) are different semantics; conflating them would revoke a grant when the
user only meant to switch accounts.

**Audit** reuses `capability-audit`: `connect`, `refresh`, `inject`,
`reauth-needed`, `disconnect`, `revoke` events recording **only `credentialId` +
host (+ method/path pattern) — never a token value or secret** (same redaction as
the network audit). A failed best-effort provider revocation is audited as such
without leaking the token.

**Observability** extends the existing governance UI: each declared credential
shows `connected | disconnected | needs-reconnect | degraded`, the bound
host/method/path summary (via the adapter), last refresh, and
Connect / Reconnect / Disconnect actions.

## Component boundaries

- **Credential Vault** — `safeStorage`-backed, identity-bound encrypted records;
  only host reads; fail-closed on mismatch/corruption; depends on Electron
  `safeStorage` + atomic JSON store.
- **Credential scope adapter** (`packages/plugin-manifest`) — delegates
  host/method/path to `networkHttpsAdapter`; owns credentialId mapping + overlap
  rejection; pure, offline-validatable like the network adapter.
- **OAuth Flow Runner** — PKCE/state + token exchange; depends on the Loopback
  Server, `shell.openExternal`, and `network-fetcher` (exchange/refresh/revoke go
  through the hardened egress).
- **Loopback Callback Server** — `node:http` on `127.0.0.1:0`; single route;
  self-closing; no plugin coupling.
- **Token Refresher** — durable timer; single-flight; depends on Vault + Flow
  Runner refresh.
- **Credential Injector** — a hook inside `network-fetcher`; depends on the
  credential/`network:https` scope adapter (`contains`) for the pin and on the
  Vault for the current token; re-checks per redirect hop; rejects plugin-set
  conflicting headers.
- **CredentialsAPI** (SDK + bridge) — `status` / `requestConnect`; never carries a
  token.
- **Governance UI** (renderer, existing surface extended) — read-only state +
  connect/reconnect/disconnect/revoke over existing IPC; secret entry is NOT here
  (it is the main-process secure surface).

## Implementation order

1. **Manifest + capability adapter** — register `credentials:broker`; credential
   scope adapter (delegating to `networkHttpsAdapter`); `credentialDeclarationHash`
   + fingerprint fold; `inject.scope ⊆ network:https` scope; reject overlapping
   inject scopes; forbidden custom-header rejection. Pure, no OS seams.
2. **Vault v1** — `safeStorage` availability check (fail-closed, no plaintext);
   identity-bound record; atomic write; corrupt/mismatch → fail-closed
   `disconnected`.
3. **Static credential** — main-process secure input; vault write; `bearer` +
   custom-header schemes (no query). Proves the storage spine without OAuth.
4. **Injector hardening** — host+method+path pin via adapter `contains`;
   plugin-set conflicting `Authorization`/header → reject; per-redirect-hop
   re-check; `disconnected` → `CredentialNotConnectedError`; trigger `uses`
   integration (§7); audit redaction.
5. **OAuth Flow Runner + Loopback Server** — endpoint validation; PKCE S256;
   single-use/timeout loopback with state mismatch counting; code exchange via
   hardened egress. Faked browser + faked provider token endpoint.
6. **Token Refresher + reconnect** — durable scheduling across restart;
   single-flight; refresh-token rotation; transient-failure backoff;
   `invalid_grant` → disconnected; reauth surfacing.
7. **Disconnect / Reconnect / Revoke + UI + audit** — three distinct actions;
   provider revocation best-effort (token read before vault delete); governance
   panel.

Each step is a thin, independently testable unit on the shared vault + egress
spine; the permission model (step 1) and the injector (steps 3–4) are built once
and reused by OAuth.

## Testing

- **Declaration governance:** `inject.scope` not ⊆ network scope → rejected; two
  credentials with overlapping inject scopes → rejected; a custom header equal to
  `Cookie`/`Host`/`Content-Length`/`Authorization` → rejected; changing
  `clientId`/endpoints/`scopes`/`inject.scope`/`scheme` yields a new fingerprint
  and invalidates prior grants.
- **Injection pinning:** token attached iff request `{host,method,path}` ⊆
  `inject.scope`; a request to the same host but an out-of-scope method/path is
  **not** injected; a redirect hop leaving the inject scope drops the credential;
  scheme variants attach correctly; disconnected → `CredentialNotConnectedError`,
  never a silent unauthenticated request.
- **Plugin-set header conflict:** plugin sets `Authorization` (or the custom
  header) while injection applies → request rejected, not overwritten.
- **Vault identity binding:** a record whose stored identity tuple differs from
  the current one → not read, treated `disconnected`; corrupt/undecryptable
  record → fail-closed.
- **safeStorage unavailable:** Connect refused; **no** plaintext vault file
  written; UI shows the unavailable state.
- **Sandbox isolation:** `ctx.credentials` exposes no token getter; `status`
  returns only the enum; `requestConnect` cannot open a browser or start a flow
  (no browser side effect in the seam).
- **OAuth flow:** loopback accepts exactly one callback with the matching `state`,
  rejects + counts a mismatched/forged `state`, fuses on timeout or mismatch
  threshold, closes after one good callback; PKCE S256 verifier sent on exchange;
  token response validated; exchange/refresh/revoke go through the hardened egress;
  `http:`/localhost/IP-literal/private/`.local` endpoint → rejected.
- **Refresh:** transient 5xx/DNS/timeout → backoff + keep unexpired token (not
  disconnected); `invalid_grant` → disconnected; refresh-token rotation persists
  atomically; a failed vault write on rotation retains the old refresh token;
  schedule re-arms after a simulated restart; single-flight under concurrent
  callers.
- **Triggers alignment:** a trigger-origin fetch to an inject host whose trigger
  `uses` omits `credentials:broker` → not injected (fails closed if dependent);
  with the credential use present and budgeted → injected and debited.
- **Revocation split:** Disconnect deletes the vault but keeps the grant (Reconnect
  works without re-consent); Revoke tombstones the grant (re-enable required);
  provider revocation runs **before** vault deletion; a failed provider revocation
  still deletes the vault and audits the best-effort failure without leaking a token.
- **End-to-end** (real vault + injector + grant store, faked browser/provider/OS
  seams) per the network-e2e pattern.
</content>
