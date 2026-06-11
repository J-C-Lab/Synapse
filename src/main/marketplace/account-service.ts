import type { User } from "@synapse/marketplace-types"
import type { MarketplaceApi } from "../plugins/marketplace-api"
import { MarketplaceApiError } from "../plugins/marketplace-api"

/** Shown to the user while a device-authorization sign-in is pending. */
export interface LoginPrompt {
  verificationUri: string
  userCode: string
  expiresAt: string
}

export interface AccountStatus {
  user: User | null
}

export interface MarketplaceTokenAccess {
  get: () => Promise<string | undefined>
  set: (token: string) => Promise<void>
  clear: () => Promise<void>
}

export interface MarketplaceAccountServiceDeps {
  api: MarketplaceApi
  store: MarketplaceTokenAccess
  openBrowser: (url: string) => Promise<void> | void
  sleep?: (ms: number) => Promise<void>
  now?: () => number
}

/**
 * Desktop marketplace sign-in via the GitHub device-authorization flow. Reuses
 * the same backend endpoints as the CLI: start a grant, open the browser, poll
 * until approved, then persist the session token (encrypted, main-process only).
 */
export class MarketplaceAccountService {
  private readonly sleep: (ms: number) => Promise<void>
  private readonly now: () => number

  constructor(private readonly deps: MarketplaceAccountServiceDeps) {
    this.sleep = deps.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.now = deps.now ?? (() => Date.now())
  }

  async login(onPrompt?: (prompt: LoginPrompt) => void): Promise<User> {
    const grant = await this.deps.api.deviceStart()
    onPrompt?.({
      verificationUri: grant.verificationUri,
      userCode: grant.userCode,
      expiresAt: grant.expiresAt,
    })
    await this.deps.openBrowser(grant.verificationUri)

    const expiresAt = Date.parse(grant.expiresAt)
    while (this.now() < expiresAt) {
      await this.sleep(grant.interval * 1000)
      let poll
      try {
        poll = await this.deps.api.devicePoll(grant.deviceCode)
      } catch (err) {
        if (err instanceof MarketplaceApiError && err.status === 410) {
          throw new Error("Sign-in expired before it was authorized. Try again.")
        }
        throw err
      }
      if (poll.status === "authorized") {
        await this.deps.store.set(poll.accessToken)
        return poll.user
      }
    }
    throw new Error("Sign-in timed out. Try again.")
  }

  async logout(): Promise<void> {
    await this.deps.store.clear()
  }

  /** The signed-in user, or null. Clears a stale token on a 401. */
  async status(): Promise<AccountStatus> {
    const token = await this.deps.store.get()
    if (!token) return { user: null }
    try {
      const { user } = await this.deps.api.session()
      return { user }
    } catch (err) {
      if (err instanceof MarketplaceApiError && err.status === 401) {
        await this.deps.store.clear()
        return { user: null }
      }
      throw err
    }
  }
}
