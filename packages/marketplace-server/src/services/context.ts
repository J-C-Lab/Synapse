import type { IdentityProvider } from "../auth/github"
import type { ServerConfig } from "../config"
import type { MarketplaceDb } from "../db/client"
import type { StorageProvider } from "../storage/types"
import type { DeviceCodeService } from "./device-code-service"
import type { PluginService } from "./plugin-service"
import type { SessionService } from "./session-service"
import type { UserService } from "./user-service"

/** The assembled service layer routes depend on. Built once in buildApp. */
export interface Services {
  db: MarketplaceDb
  config: ServerConfig
  github: IdentityProvider
  storage: StorageProvider
  users: UserService
  sessions: SessionService
  deviceCodes: DeviceCodeService
  plugins: PluginService
}
