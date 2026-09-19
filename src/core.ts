/**
 * Bridge core: workspace attach, RPC dispatch, event push, and discovery
 * publishing — everything except the Cordis wiring in `index.ts`. The class
 * depends on narrow service slices so unit tests can drive it with mocks.
 *
 * @module dsh-vscode-bridge/core
 */

import { randomBytes } from 'node:crypto'
import type { AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { AgentPresets } from '@deepseek-ai/dsh-agent-presets'
import type { PermissionPresetService } from '@deepseek-ai/dsh-permission-presets'
import type { Session, SessionEvent, SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { SessionTitleService } from '@deepseek-ai/dsh-session-title'
import type { WorkspaceRegistry } from '@deepseek-ai/dsh-workspace'
import { DiscoveryFile } from './discovery.ts'
import {
  BRIDGE_PLUGIN_NAME,
  BRIDGE_PROTOCOL_VERSION,
  BridgeRpcError,
  DEFAULT_PUSH_TYPES,
  RPC_CONFLICT,
  RPC_INTERNAL_ERROR,
  RPC_INVALID_PARAMS,
  RPC_INVALID_REQUEST,
  RPC_METHOD_NOT_FOUND,
  RPC_NOT_FOUND,
  RPC_PARSE_ERROR,
  RPC_SERVICE_UNAVAILABLE,
  RPC_UNAUTHORIZED,
  type BridgeCapabilities,
  type JsonRpcFailure,
  type JsonRpcNotification,
  type JsonRpcRequest,
} from './protocol.ts'
import { BridgeTcpServer, type BridgeTransportLogger } from './server.ts'

/** Config with every optional field resolved (schema defaults applied). */
export interface ResolvedBridgeConfig {
  readonly host: string
  readonly portStart: number
  readonly portEnd: number
  readonly token: string
  /** Directory holding the single `<pid>.json` discovery file. */
  readonly discoveryDir: string
  readonly attachSessions: boolean
}

/** The slice of harness services the bridge consumes. */
export interface BridgeCoreDeps {
  readonly logger: BridgeTransportLogger
  readonly config: ResolvedBridgeConfig
  readonly version: string
  readonly sessions: SessionStore
  readonly sessionPersistence?: SessionPersistence
  readonly sessionTitle?: SessionTitleService
  readonly workspaceRegistry?: WorkspaceRegistry
  readonly permissionPresets?: PermissionPresetService
  readonly agents?: AgentRegistry
  /** Lazy lookup: `agentPresets` is optional and resolved at request time. */
  readonly getAgentPresets: () => AgentPresets | undefined
}

interface SubscriptionState {
  readonly sessionId?: string
  readonly types: readonly string[]
}

/** Cast a wire string to the branded id; validation happened on lookup. */
const asSessionId = (id: string): SessionId => id as SessionId

/**
 * The bridge itself. Owns the TCP listener, the discovery file, and every
 * RPC handler. Cordis event hooks call {@link attachSession} and
 * {@link handleSessionEvent}; teardown goes through {@link stop}.
 */
export class BridgeCore {
  private readonly token: string
  private readonly discovery: DiscoveryFile
  private server: BridgeTcpServer | undefined
  private readonly subscriptions = new Map<number, SubscriptionState>()
  private readonly startedAt = new Date().toISOString()
  private stopping = false
  private readonly deps: BridgeCoreDeps

  constructor(deps: BridgeCoreDeps) {
    this.deps = deps
    this.token = deps.config.token
    this.discovery = new DiscoveryFile({
      directory: deps.config.discoveryDir,
      logger: deps.logger,
    })
  }

  /** The token clients must present (also written into the discovery file). */
  get bearerToken(): string {
    return this.token
  }

  /** The occupied port once {@link start} bound the listener. */
  get port(): number | undefined {
    return this.server?.port
  }

  /** What the deployment can actually do, derived from live services. */
  capabilities(): BridgeCapabilities {
    return {
      workspaceGrouping: this.deps.workspaceRegistry !== undefined,
      sessionTitle: this.deps.sessionTitle !== undefined,
      sessionArchive: this.deps.workspaceRegistry !== undefined,
      presets: this.deps.getAgentPresets() !== undefined,
      permissions: this.deps.permissionPresets !== undefined,
      eventPush: true,
    }
  }

  /**
   * Attach already-live sessions (best-effort sweep), bind the TCP listener,
   * reap stale discovery entries, and publish ours. A port-range exhaustion
   * degrades the plugin to attach-only instead of failing the profile boot.
   */
  async start(): Promise<void> {
    if (this.deps.config.attachSessions) {
      for (const session of this.deps.sessions.list()) {
        await this.attachSession(session)
      }
    }
    const server = new BridgeTcpServer({
      host: this.deps.config.host,
      portStart: this.deps.config.portStart,
      portEnd: this.deps.config.portEnd,
      logger: this.deps.logger,
      onLine: (connectionId, line) => {
        void this.handleLine(connectionId, line)
      },
      onConnectionClosed: (connectionId) => {
        this.subscriptions.delete(connectionId)
      },
    })
    try {
      await server.start()
      this.server = server
    } catch (error: unknown) {
      this.deps.logger.error?.(`dsh-vscode-bridge: TCP listener unavailable: ${String(error)}`)
      return
    }
    await this.discovery.sweepStale()
    await this.publishDiscovery()
    process.once('exit', this.clearDiscoverySync)
  }

  /** Release the listener, subscriptions, and the discovery file. */
  async stop(): Promise<void> {
    if (this.stopping) return
    this.stopping = true
    process.removeListener('exit', this.clearDiscoverySync)
    this.subscriptions.clear()
    await this.server?.stop()
    this.server = undefined
    await this.discovery.clear()
  }

  private readonly clearDiscoverySync = (): void => {
    this.discovery.clearSync()
  }

  /**
   * Attach one freshly created session to the workspace owning its cwd,
   * creating the workspace when missing. Never throws: a throwing
   * `session/created` listener would veto session creation, so every failure
   * is logged and reported instead.
   */
  async attachSession(session: Session): Promise<{ attached: boolean; workspaceId?: string; reason?: string }> {
    const registry = this.deps.workspaceRegistry
    if (registry === undefined) return { attached: false, reason: 'workspace-unavailable' }
    if (session.header.parentSession !== undefined) return { attached: false, reason: 'subagent' }
    const cwd = session.header.cwd
    if (cwd === undefined) return { attached: false, reason: 'no-cwd' }
    try {
      const workspace = (await registry.resolveByPath(cwd)) ?? (await registry.create(cwd))
      if ((workspace.sessionIds as readonly string[]).includes(session.id)) {
        return { attached: true, workspaceId: workspace.id, reason: 'already' }
      }
      await workspace.attachSession(session.id)
      this.deps.logger.info(`dsh-vscode-bridge: attached session ${session.id} to workspace ${workspace.id} (${workspace.path})`)
      await this.publishDiscovery()
      return { attached: true, workspaceId: workspace.id }
    } catch (error: unknown) {
      this.deps.logger.warn(`dsh-vscode-bridge: cannot attach session ${session.id} (cwd ${cwd}): ${String(error)}`)
      return { attached: false, reason: String(error) }
    }
  }

  /**
   * Fan one session event out to matching subscribers as a `bridge.event`
   * notification. Event `data` is already JSON-serializable session log data.
   */
  handleSessionEvent(session: Session, event: SessionEvent): void {
    if (this.subscriptions.size === 0 || this.server === undefined) return
    for (const [connectionId, subscription] of this.subscriptions) {
      if (subscription.sessionId !== undefined && subscription.sessionId !== session.id) continue
      if (!matchesEventType(subscription.types, event.type)) continue
      const notification: JsonRpcNotification = {
        jsonrpc: '2.0',
        method: 'bridge.event',
        params: {
          kind: 'session/event',
          sessionId: session.id,
          event: {
            type: event.type,
            seq: event.seq,
            time: event.time,
            data: event.data,
          },
        },
      }
      this.server.send(connectionId, notification)
    }
  }

  /** Parse, authenticate, and dispatch one framed line. */
  private async handleLine(connectionId: number, line: string): Promise<void> {
    const server = this.server
    if (server === undefined) return
    let message: unknown
    try {
      message = JSON.parse(line)
    } catch {
      server.send(connectionId, failure(null, RPC_PARSE_ERROR, 'parse error: line is not valid JSON'))
      return
    }
    if (message === null || typeof message !== 'object' || Array.isArray(message)) {
      server.send(connectionId, failure(null, RPC_INVALID_REQUEST, 'invalid request: expected a JSON object'))
      return
    }
    const request = message as Partial<JsonRpcRequest>
    const id = typeof request.id === 'string' || typeof request.id === 'number' ? request.id : null
    if (id === null || typeof request.method !== 'string' || request.method.length === 0) {
      server.send(connectionId, failure(id, RPC_INVALID_REQUEST, 'invalid request: `id` (string|number) and `method` are required'))
      return
    }
    if (request.token !== this.token) {
      server.send(connectionId, failure(id, RPC_UNAUTHORIZED, 'unauthorized: missing or wrong token'))
      return
    }
    try {
      const result = await this.dispatch(request.method, request.params, connectionId)
      server.send(connectionId, { jsonrpc: '2.0', id, result })
    } catch (error: unknown) {
      server.send(connectionId, this.wireError(id, error))
    }
  }

  private wireError(id: string | number, error: unknown): JsonRpcFailure {
    if (error instanceof BridgeRpcError) {
      return error.data === undefined
        ? failure(id, error.code, error.message)
        : failure(id, error.code, error.message, error.data)
    }
    // Typert RemoteError and similar carriers expose a stable string code.
    const remoteCode = (error as { code?: unknown } | null)?.code
    if (typeof remoteCode === 'string' && remoteCode.length > 0) {
      const details = (error as { details?: unknown }).details
      return failure(id, RPC_CONFLICT, String((error as Error).message ?? error), { code: remoteCode, details })
    }
    return failure(id, RPC_INTERNAL_ERROR, String(error))
  }

  private async dispatch(method: string, params: unknown, connectionId: number): Promise<unknown> {
    switch (method) {
      case 'bridge.handshake':
        return {
          protocolVersion: BRIDGE_PROTOCOL_VERSION,
          plugin: BRIDGE_PLUGIN_NAME,
          version: this.deps.version,
          pid: process.pid,
          startedAt: this.startedAt,
          capabilities: this.capabilities(),
        }
      case 'session.list':
        return this.listSessions(params)
      case 'session.get':
        return await this.getSession(params)
      case 'session.setTitle':
        return this.setSessionTitle(params)
      case 'session.delete':
        return await this.deleteSession(params)
      case 'session.subscribe':
        return this.subscribe(connectionId, params)
      case 'session.unsubscribe':
        return this.unsubscribe(connectionId)
      case 'preset.list':
        return await this.listPresets()
      case 'preset.current':
        return this.currentPreset(params)
      case 'preset.select':
        return await this.selectPreset(params)
      case 'permission.get':
        return this.getPermission(params)
      case 'permission.set':
        return this.setPermission(params)
      case 'workspace.list':
        return this.listWorkspaces()
      case 'workspace.attach':
        return await this.attachRequested(params)
      default:
        throw new BridgeRpcError(RPC_METHOD_NOT_FOUND, `method not found: ${method}`)
    }
  }

  // —— session.* ——

  private async listSessions(params: unknown): Promise<unknown> {
    const includeStored = optionalBoolean(params, 'includeStored') ?? false
    const live = this.deps.sessions.list().map((session) => this.describeLive(session))
    if (!includeStored || this.deps.sessionPersistence === undefined) {
      return { sessions: live, storedIncluded: false }
    }
    const liveIds = new Set(this.deps.sessions.list().map((session) => String(session.id)))
    const snapshots = await this.storedSnapshots()
    return {
      sessions: live,
      storedIncluded: true,
      // Header-only rows; fold a stored title through `session.get`.
      stored: snapshots
        .filter((snapshot) => !liveIds.has(String(snapshot.header.id)))
        .map((snapshot) => ({
          sessionId: snapshot.header.id,
          live: false,
          cwd: snapshot.header.cwd ?? null,
          createdAt: snapshot.header.createdAt,
          parentSession: snapshot.header.parentSession ?? null,
          agentPreset: snapshot.header.agentPreset ?? null,
        })),
    }
  }

  private async storedSnapshots() {
    const persistence = this.deps.sessionPersistence
    if (persistence === undefined) return []
    try {
      return await persistence.list()
    } catch (error: unknown) {
      this.deps.logger.warn(`dsh-vscode-bridge: sessionPersistence.list failed: ${String(error)}`)
      return []
    }
  }

  private async getSession(params: unknown): Promise<unknown> {
    const sessionId = requireString(params, 'sessionId')
    const live = this.deps.sessions.get(asSessionId(sessionId))
    if (live !== undefined) return this.describeLive(live)
    const persistence = this.deps.sessionPersistence
    if (persistence === undefined) {
      throw new BridgeRpcError(RPC_NOT_FOUND, `unknown session: ${sessionId}`, { code: 'session/not-found' })
    }
    const snapshot = await persistence.stat(asSessionId(sessionId))
    if (snapshot === undefined) {
      throw new BridgeRpcError(RPC_NOT_FOUND, `unknown session: ${sessionId}`, { code: 'session/not-found' })
    }
    const handle = await persistence.open(asSessionId(sessionId), 'read')
    try {
      const { events } = await handle.read()
      const titleEvent = events.findLast((event) => event.type === 'session/title')
      const title = titleEvent === undefined ? null : (titleEvent.data as { title: string }).title
      return {
        sessionId,
        live: false,
        title,
        cwd: snapshot.header.cwd ?? null,
        createdAt: snapshot.header.createdAt,
        parentSession: snapshot.header.parentSession ?? null,
        agentPreset: snapshot.header.agentPreset ?? null,
      }
    } finally {
      await handle.close()
    }
  }

  private setSessionTitle(params: unknown): unknown {
    const sessionId = requireString(params, 'sessionId')
    const title = requireString(params, 'title')
    const service = this.requireService(this.deps.sessionTitle, 'sessionTitle')
    const session = this.requireLiveSession(sessionId)
    const snapshot = service.rename(session, title)
    return { sessionId, title: snapshot.title, updatedAt: snapshot.updatedAt }
  }

  private async deleteSession(params: unknown): Promise<unknown> {
    const sessionId = requireString(params, 'sessionId')
    const registry = this.requireService(this.deps.workspaceRegistry, 'workspaceRegistry')
    try {
      await registry.archiveSession(asSessionId(sessionId))
    } catch (error: unknown) {
      if ((error as { name?: string }).name === 'WorkspaceUnknownSessionError') {
        throw new BridgeRpcError(RPC_NOT_FOUND, `unknown session: ${sessionId}`, { code: 'session/not-found' })
      }
      throw error
    }
    return { sessionId, archived: true }
  }

  private subscribe(connectionId: number, params: unknown): unknown {
    const sessionId = optionalString(params, 'sessionId')
    const types = optionalStringArray(params, 'types')
    const subscription: SubscriptionState = {
      ...(sessionId === undefined ? {} : { sessionId }),
      types: types ?? DEFAULT_PUSH_TYPES,
    }
    this.subscriptions.set(connectionId, subscription)
    return { subscribed: true, types: subscription.types }
  }

  private unsubscribe(connectionId: number): unknown {
    this.subscriptions.delete(connectionId)
    return { subscribed: false }
  }

  // —— preset.* ——

  private async listPresets(): Promise<unknown> {
    const presets = this.requireService(this.deps.getAgentPresets(), 'agentPresets')
    const roster = await presets.list()
    const defaultId = presets.defaultId
    return {
      default: defaultId,
      presets: roster.map((preset) => ({
        id: preset.id,
        trust: preset.trust,
        isDefault: preset.id === defaultId,
        ...(preset.name === undefined ? {} : { name: preset.name }),
        ...(preset.description === undefined ? {} : { description: preset.description }),
        ...(preset.broken === undefined ? {} : { broken: preset.broken }),
      })),
    }
  }

  private currentPreset(params: unknown): unknown {
    const sessionId = requireString(params, 'sessionId')
    const session = this.requireLiveSession(sessionId)
    const agent = this.deps.agents?.get(session.id)
    const composed = agent === undefined
      ? undefined
      : this.deps.getAgentPresets()?.composedPreset(agent.ctx)
    return { sessionId, preset: composed ?? session.header.agentPreset ?? null }
  }

  private async selectPreset(params: unknown): Promise<unknown> {
    const sessionId = requireString(params, 'sessionId')
    const presetId = requireString(params, 'presetId')
    const presets = this.requireService(this.deps.getAgentPresets(), 'agentPresets')
    const agents = this.requireService(this.deps.agents, 'agents')
    const session = this.requireLiveSession(sessionId)
    const agent = agents.get(session.id)
    if (agent === undefined) {
      throw new BridgeRpcError(RPC_CONFLICT, `session ${sessionId} has no live agent`, { code: 'session/no-agent' })
    }
    const selected = await presets.select(agent, presetId)
    return { sessionId, selected }
  }

  // —— permission.* ——

  private getPermission(params: unknown): unknown {
    const service = this.requireService(this.deps.permissionPresets, 'permissionPresets')
    const result: Record<string, unknown> = {
      options: service.names.map((name) => service.optionOf(name)),
      default: service.defaultPreset,
    }
    const sessionId = optionalString(params, 'sessionId')
    if (sessionId !== undefined) {
      result.current = service.current(this.requireLiveSession(sessionId))
    }
    return result
  }

  private setPermission(params: unknown): unknown {
    const sessionId = requireString(params, 'sessionId')
    const name = requireString(params, 'name')
    const service = this.requireService(this.deps.permissionPresets, 'permissionPresets')
    const session = this.requireLiveSession(sessionId)
    if (!service.names.includes(name)) {
      throw new BridgeRpcError(RPC_INVALID_PARAMS, `unknown permission preset "${name}" (known: ${service.names.join(', ')})`, { code: 'permission/unknown-preset' })
    }
    service.set(session, name)
    return { sessionId, current: service.current(session) }
  }

  // —— workspace.* ——

  private listWorkspaces(): unknown {
    const registry = this.requireService(this.deps.workspaceRegistry, 'workspaceRegistry')
    return {
      workspaces: registry.list().map((workspace) => ({
        id: workspace.id,
        path: workspace.path,
        title: workspace.title,
        sessionIds: workspace.sessionIds,
      })),
      archivedSessionIds: registry.archivedSessionIds,
    }
  }

  private async attachRequested(params: unknown): Promise<unknown> {
    const sessionId = requireString(params, 'sessionId')
    const session = this.requireLiveSession(sessionId)
    return await this.attachSession(session)
  }

  // —— helpers ——

  private describeLive(session: Session): Record<string, unknown> {
    return {
      sessionId: session.id,
      live: true,
      cwd: session.header.cwd ?? null,
      createdAt: session.header.createdAt,
      parentSession: session.header.parentSession ?? null,
      title: this.safeRead(() => this.deps.sessionTitle?.get(session)?.title ?? null),
      permission: this.safeRead(() => this.deps.permissionPresets?.current(session) ?? null),
      agentPreset: this.agentPresetOf(session),
    }
  }

  private agentPresetOf(session: Session): string | null {
    const agent = this.safeRead(() => this.deps.agents?.get(session.id))
    if (agent === undefined || agent === null) return session.header.agentPreset ?? null
    return this.safeRead(() => this.deps.getAgentPresets()?.composedPreset(agent.ctx) ?? null)
      ?? session.header.agentPreset ?? null
  }

  private safeRead<T>(read: () => T): T | null {
    try {
      return read()
    } catch {
      return null
    }
  }

  private requireLiveSession(sessionId: string): Session {
    const session = this.deps.sessions.get(asSessionId(sessionId))
    if (session === undefined) {
      throw new BridgeRpcError(RPC_NOT_FOUND, `session is not live: ${sessionId}`, { code: 'session/not-live' })
    }
    return session
  }

  private requireService<T>(service: T | undefined, name: string): T {
    if (service === undefined) {
      throw new BridgeRpcError(
        RPC_SERVICE_UNAVAILABLE,
        `service "${name}" is not available in this profile`,
        { code: 'service-unavailable', service: name },
      )
    }
    return service
  }

  /**
   * Republish the discovery file with the current candidate directories.
   * An unwritable discovery directory downgrades the plugin to
   * attach-only-without-discovery — it must never break the listener.
   */
  private async publishDiscovery(): Promise<void> {
    const server = this.server
    if (server === undefined || server.port === undefined) return
    try {
      await this.discovery.publish({
        protocolVersion: BRIDGE_PROTOCOL_VERSION,
        plugin: BRIDGE_PLUGIN_NAME,
        version: this.deps.version,
        pid: process.pid,
        host: this.deps.config.host,
        port: server.port,
        token: this.token,
        startedAt: this.startedAt,
        capabilities: this.capabilities(),
        directories: [...this.discoveryDirectories()].sort(),
      })
    } catch (error: unknown) {
      this.deps.logger.warn(`dsh-vscode-bridge: cannot write discovery file ${this.discovery.path}: ${String(error)}`)
    }
  }

  private discoveryDirectories(): Set<string> {
    const directories = new Set<string>([process.cwd()])
    for (const session of this.deps.sessions.list()) {
      if (session.header.cwd !== undefined) directories.add(session.header.cwd)
    }
    try {
      for (const workspace of this.deps.workspaceRegistry?.list() ?? []) {
        directories.add(workspace.path)
      }
    } catch (error: unknown) {
      this.deps.logger.warn(`dsh-vscode-bridge: workspace listing failed: ${String(error)}`)
    }
    return directories
  }
}

/** Whether one subscription filter admits one session event type. */
export function matchesEventType(types: readonly string[], eventType: string): boolean {
  for (const pattern of types) {
    if (pattern === '*') return true
    if (pattern.endsWith('/')) {
      if (eventType.startsWith(pattern)) return true
    } else if (eventType === pattern) {
      return true
    }
  }
  return false
}

function failure(id: string | number | null, code: number, message: string, data?: unknown): JsonRpcFailure {
  return {
    jsonrpc: '2.0',
    id,
    error: data === undefined ? { code, message } : { code, message, data },
  }
}

function asRecord(params: unknown): Record<string, unknown> {
  if (params === undefined || params === null) return {}
  if (typeof params !== 'object' || Array.isArray(params)) {
    throw new BridgeRpcError(RPC_INVALID_PARAMS, 'params must be an object')
  }
  return params as Record<string, unknown>
}

function requireString(params: unknown, field: string): string {
  const value = asRecord(params)[field]
  if (typeof value !== 'string' || value.length === 0) {
    throw new BridgeRpcError(RPC_INVALID_PARAMS, `\`${field}\` must be a non-empty string`)
  }
  return value
}

function optionalString(params: unknown, field: string): string | undefined {
  const value = asRecord(params)[field]
  if (value === undefined) return undefined
  if (typeof value !== 'string' || value.length === 0) {
    throw new BridgeRpcError(RPC_INVALID_PARAMS, `\`${field}\` must be a non-empty string when present`)
  }
  return value
}

function optionalBoolean(params: unknown, field: string): boolean | undefined {
  const value = asRecord(params)[field]
  if (value === undefined) return undefined
  if (typeof value !== 'boolean') {
    throw new BridgeRpcError(RPC_INVALID_PARAMS, `\`${field}\` must be a boolean when present`)
  }
  return value
}

function optionalStringArray(params: unknown, field: string): string[] | undefined {
  const value = asRecord(params)[field]
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.some((entry) => typeof entry !== 'string' || entry.length === 0)) {
    throw new BridgeRpcError(RPC_INVALID_PARAMS, `\`${field}\` must be an array of non-empty strings when present`)
  }
  return value as string[]
}
