// @synapsepkg/agent-protocol
//
// Renderer-safe durable agent run protocol: lifecycle status/recovery
// vocabulary, the run event union, and run snapshot/summary projections.
// Shared by Synapse's main, preload, and renderer processes so none of them
// maintains a second manually-synced copy of this contract.

export * from "./events"
export * from "./snapshots"
