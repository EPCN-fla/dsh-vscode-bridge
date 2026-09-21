/**
 * Wire protocol for the dsh-vscode-bridge TCP channel: newline-delimited
 * JSON-RPC 2.0 with a per-request bearer token. Every client message is one
 * JSON object per line; every server message is one JSON object per line.
 *
 * Auth: the token lives in the discovery file
 * (`$HOME/.dsh/vscode-bridge/<pid>.json`, mode 0600). Every request —
 * including `bridge.handshake` — must carry it in the top-level `token`
 * field.
 *
 * @module dsh-vscode-bridge/protocol
 */

/** Protocol revision bumped on breaking wire changes. */
export const BRIDGE_PROTOCOL_VERSION = 1

/** Plugin module name, mirrored in discovery files and handshake payloads. */
export const BRIDGE_PLUGIN_NAME = 'dsh-vscode-bridge'

export interface JsonRpcRequest {
  readonly jsonrpc?: '2.0'
  readonly id: string | number
  readonly method: string
  readonly params?: unknown
  readonly token?: string
}

export interface JsonRpcSuccess {
  readonly jsonrpc: '2.0'
  readonly id: string | number
  readonly result: unknown
}

export interface JsonRpcFailure {
  readonly jsonrpc: '2.0'
  readonly id: string | number | null
  readonly error: {
    readonly code: number
    readonly message: string
    readonly data?: unknown
  }
}

export interface JsonRpcNotification {
  readonly jsonrpc: '2.0'
  readonly method: string
  readonly params?: unknown
}

export type JsonRpcServerMessage = JsonRpcSuccess | JsonRpcFailure | JsonRpcNotification

// Standard JSON-RPC 2.0 codes.
export const RPC_PARSE_ERROR = -32700
export const RPC_INVALID_REQUEST = -32600
export const RPC_METHOD_NOT_FOUND = -32601
export const RPC_INVALID_PARAMS = -32602
export const RPC_INTERNAL_ERROR = -32603
// Server-defined codes (-32099..-32000).
export const RPC_SERVER_ERROR = -32000
export const RPC_UNAUTHORIZED = -32001
export const RPC_SERVICE_UNAVAILABLE = -32002
export const RPC_NOT_FOUND = -32004
export const RPC_CONFLICT = -32009

/**
 * One failure the dispatcher answers with a structured wire error. `data.code`
 * carries stable machine-readable detail (for example `session/not-live`,
 * `agent-preset/locked`, `service-unavailable`).
 */
export class BridgeRpcError extends Error {
  readonly code: number
  readonly data?: unknown

  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.name = 'BridgeRpcError'
    this.code = code
    this.data = data
  }
}

/** Feature flags reported by `bridge.handshake` and the discovery file. */
export interface BridgeCapabilities {
  /** session/created → workspaceRegistry attach (the "ungrouped session" fix). */
  readonly workspaceGrouping: boolean
  /** Native session title read/write via `sessionTitle`. */
  readonly sessionTitle: boolean
  /** Session archive ("delete") via `workspaceRegistry.archiveSession`. */
  readonly sessionArchive: boolean
  /** Agent preset roster and per-session switching via `agentPresets`. */
  readonly presets: boolean
  /** Permission preset query/switch via `permissionPresets`. */
  readonly permissions: boolean
  /** Native slash-command catalog and execution via `commands` (command.list / command.run). */
  readonly commands: boolean
  /** Read-only skill catalog via `skills` (skill.list). */
  readonly skills: boolean
  /** Session-log ZIP export to a host file via `session.exportZip`. */
  readonly sessionExport: boolean
  /** Server-push `bridge.event` notifications for subscribed session events. */
  readonly eventPush: boolean
}

/**
 * Contents of `$HOME/.dsh/vscode-bridge/<pid>.json`. Deleted on plugin
 * unload; stale entries are reaped by the next instance that starts.
 */
export interface DiscoveryFilePayload {
  readonly protocolVersion: number
  readonly plugin: typeof BRIDGE_PLUGIN_NAME
  readonly version: string
  readonly pid: number
  readonly host: string
  readonly port: number
  readonly token: string
  readonly startedAt: string
  readonly capabilities: BridgeCapabilities
  /**
   * Directories this instance serves — process cwd, live session cwds, and
   * known workspace paths (sorted). Clients match the folder they opened
   * against this list to pick their instance.
   */
  readonly directories: readonly string[]
}

/** Subscription accepted by `session.subscribe`. */
export interface EventSubscription {
  /** Only forward this session's events; omitted means every session. */
  readonly sessionId?: string
  /**
   * Event type filter. An entry ending in `/` matches by prefix
   * (`plan/` matches `plan/update`); any other entry matches exactly.
   * Omitted or empty subscribes to the default set.
   */
  readonly types?: readonly string[]
}

/** Default event types pushed to subscribers that pass no explicit filter. */
export const DEFAULT_PUSH_TYPES: readonly string[] = [
  'session/title',
  'permission/preset',
  'sandbox/mode',
  'approval/policy',
  'agent-preset/selected',
  'command/',
  'plan/',
  'todo/',
]
