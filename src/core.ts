/**
 * Bridge core: workspace attach, RPC dispatch, event push, and discovery
 * publishing — everything except the Cordis wiring in `index.ts`. The class
 * depends on narrow service slices so unit tests can drive it with mocks.
 *
 * @module dsh-vscode-bridge/core
 */

import { randomBytes } from 'node:crypto'
import { createWriteStream } from 'node:fs'
import { mkdir, open, stat, unlink } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'
import type { Agent, AgentRegistry } from '@deepseek-ai/dsh-agent'
import type { AgentPresets } from '@deepseek-ai/dsh-agent-presets'
import type { CommandRuntime } from '@deepseek-ai/dsh-commands'
import type { PermissionPresetService } from '@deepseek-ai/dsh-permission-presets'
import type { Session, SessionEvent, SessionHeader, SessionId, SessionStore } from '@deepseek-ai/dsh-session'
import type { SessionPersistence } from '@deepseek-ai/dsh-session-persistence'
import type { SessionTitleService } from '@deepseek-ai/dsh-session-title'
import type { SkillRegistry, SkillViewOptions } from '@deepseek-ai/dsh-skill'
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
  RPC_SERVER_ERROR,
  RPC_SERVICE_UNAVAILABLE,
  RPC_UNAUTHORIZED,
  type BridgeCapabilities,
  type JsonRpcFailure,
  type JsonRpcNotification,
  type JsonRpcRequest,
} from './protocol.ts'
import { BridgeTcpServer, type BridgeTransportLogger } from './server.ts'

/**
 * The lazily imported `@deepseek-ai/dsh-session-log-export` module. It is a
 * devDependency for types only and deliberately absent from peerDependencies:
 * a deployment that cannot resolve it degrades `session.exportZip` to
 * `service-unavailable` without affecting plugin load.
 */
type SessionLogExportModule = typeof import('@deepseek-ai/dsh-session-log-export')
/** Service bag the archive helpers read, sourced from injected/probed deps. */
type SessionLogExportDeps = import('@deepseek-ai/dsh-session-log-export').SessionLogExportDeps
/** The export services narrowed to the mounted ones the stream reads. */
type SessionLogExportReady = import('@deepseek-ai/dsh-session-log-export').SessionLogExportReady

/** Config with every optional field resolved (schema defaults applied). */
export interface ResolvedBridgeConfig {
  readonly host: string
  readonly portStart: number
  readonly portEnd: number
  readonly token: string
  /** Directory holding the single `<pid>.json` discovery file. */
  readonly discoveryDir: string
  readonly attachSessions: boolean
  /** Default `command.run` execution timeout; the request aborts past it. */
  readonly commandTimeoutMs: number
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
  /** Lazy lookup: `commands` is optional and resolved at request time. */
  readonly getCommands: () => CommandRuntime | undefined
  /** Lazy lookup: `skills` is optional and resolved at request time. */
  readonly getSkills: () => SkillRegistry | undefined
  /**
   * Lazy probe for the `sessionQuery` engine. The bridge never calls it
   * directly — it gates the `sessionExport` capability and is forwarded into
   * the lazily imported archive module, whose own types validate the shape.
   */
  readonly getSessionQuery: () => SessionLogExportDeps['sessionQuery']
  /** Lazy lookup for the `attachments` store forwarded into the archive module. */
  readonly getAttachments: () => SessionLogExportDeps['attachments']
  /** Lazy loader for the optional archive module; `undefined` when unresolvable. */
  readonly loadSessionLogExport: () => Promise<SessionLogExportModule | undefined>
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
  /** In-flight abortable RPC work (command executions, exports) per connection. */
  private readonly inflight = new Map<number, Set<AbortController>>()
  private readonly startedAt = new Date().toISOString()
  private stopping = false
  private readonly deps: BridgeCoreDeps
  /** Cached first-call probe of the archive module; tri-state via settlement. */
  private sessionLogExportProbe: Promise<SessionLogExportModule | undefined> | undefined
  /** Once probed, whether the archive module resolved (optimistic until then). */
  private sessionLogExportResolved: boolean | undefined

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
      commands: this.deps.getCommands() !== undefined,
      skills: this.deps.getSkills() !== undefined,
      // Lightweight handshake check: the engine service gates the feature; the
      // archive module probe happens on first call and a cached failure flips
      // this to false on later handshakes.
      sessionExport: this.deps.getSessionQuery() !== undefined && this.sessionLogExportResolved !== false,
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
        this.abortInflight(connectionId)
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
    for (const connectionId of [...this.inflight.keys()]) this.abortInflight(connectionId)
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
    return await this.attachByHeader(session.id, session.header)
  }

  /**
   * Shared attach core for live and stored sessions. Membership is decided by
   * the immutable header cwd, so a persisted session created out-of-process
   * (e.g. by a spawned ACP host) attaches exactly like a live one. Never
   * throws, mirroring {@link attachSession}'s `session/created` contract.
   */
  private async attachByHeader(sessionId: SessionId, header: SessionHeader): Promise<{ attached: boolean; workspaceId?: string; reason?: string }> {
    const registry = this.deps.workspaceRegistry
    if (registry === undefined) return { attached: false, reason: 'workspace-unavailable' }
    if (header.parentSession !== undefined) return { attached: false, reason: 'subagent' }
    const cwd = header.cwd
    if (cwd === undefined) return { attached: false, reason: 'no-cwd' }
    try {
      const workspace = (await registry.resolveByPath(cwd)) ?? (await registry.create(cwd))
      if ((workspace.sessionIds as readonly string[]).includes(sessionId)) {
        return { attached: true, workspaceId: workspace.id, reason: 'already' }
      }
      await workspace.attachSession(sessionId)
      this.deps.logger.info(`dsh-vscode-bridge: attached session ${sessionId} to workspace ${workspace.id} (${workspace.path})`)
      await this.publishDiscovery()
      return { attached: true, workspaceId: workspace.id }
    } catch (error: unknown) {
      this.deps.logger.warn(`dsh-vscode-bridge: cannot attach session ${sessionId} (cwd ${cwd}): ${String(error)}`)
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
      case 'command.list':
        return this.listCommands(params)
      case 'command.run':
        return await this.runCommand(params, connectionId)
      case 'skill.list':
        return await this.listSkills(params)
      case 'session.exportZip':
        return await this.exportSessionZip(params, connectionId)
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
    const live = this.deps.sessions.get(asSessionId(sessionId))
    if (live !== undefined) return await this.attachSession(live)
    // A session created out-of-process (e.g. by a spawned ACP host) is never
    // live in this host; fall back to its stored header — membership is
    // cwd-decided, so the attach validates identically.
    const snapshot = await this.deps.sessionPersistence?.stat(asSessionId(sessionId))
    if (snapshot === undefined) {
      throw new BridgeRpcError(RPC_NOT_FOUND, `unknown session: ${sessionId}`, { code: 'session/not-found' })
    }
    return await this.attachByHeader(asSessionId(sessionId), snapshot.header)
  }

  // —— command.* ——

  private listCommands(params: unknown): unknown {
    const sessionId = requireString(params, 'sessionId')
    const commands = this.requireService(this.deps.getCommands(), 'commands')
    const agent = this.requireLiveAgent(sessionId)
    return {
      // Trimmed mapping of the upstream descriptor view: `definitionId` is an
      // unstable upstream surface and never crosses the wire.
      commands: commands.list(agent).map((descriptor) => ({
        name: descriptor.name,
        description: descriptor.description,
        ...(descriptor.input?.hint === undefined ? {} : { inputHint: descriptor.input.hint }),
        ...(descriptor.input?.attachments === true ? { attachments: true } : {}),
      })),
    }
  }

  private async runCommand(params: unknown, connectionId: number): Promise<unknown> {
    const sessionId = requireString(params, 'sessionId')
    const line = requireString(params, 'line')
    if (!line.startsWith('/')) {
      throw new BridgeRpcError(RPC_INVALID_PARAMS, '`line` must be a slash command starting with `/`')
    }
    const timeoutMs = optionalNumber(params, 'timeoutMs') ?? this.deps.config.commandTimeoutMs
    const commands = this.requireService(this.deps.getCommands(), 'commands')
    const agent = this.requireLiveAgent(sessionId)
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort(new BridgeRpcError(
        RPC_SERVER_ERROR,
        `command did not settle within ${timeoutMs}ms`,
        { code: 'command/timeout' },
      ))
    }, timeoutMs)
    this.trackInflight(connectionId, controller)
    try {
      const aborted = new Promise<never>((_, reject) => {
        controller.signal.addEventListener('abort', () => reject(controller.signal.reason), { once: true })
      })
      // The same execution path the TUI/Web composers take; `submittedAttachments`
      // stays empty because ACP has no staged-receipt channel. The race answers
      // the RPC at the timeout even when a handler never observes the signal.
      const execution = await Promise.race([commands.execute(agent, line, [], controller.signal), aborted])
      if (execution === undefined) {
        throw new BridgeRpcError(RPC_INVALID_PARAMS, `unknown command: ${line}`, { code: 'command/unknown' })
      }
      // Result shape is always the upstream `CommandExecution.result`:
      // handler-level failure (e.g. compact reporting `busy`) arrives as
      // `kind: 'error'` with text, never as an RPC error.
      return {
        commandId: String(execution.commandId),
        kind: execution.result.kind,
        ...(execution.result.text === undefined ? {} : { text: execution.result.text }),
        ...(execution.result.kind === 'success' && execution.result.sourceEventSeq !== undefined
          ? { sourceEventSeq: execution.result.sourceEventSeq }
          : {}),
      }
    } catch (error: unknown) {
      if (error instanceof BridgeRpcError) throw error
      if (controller.signal.aborted) {
        const reason = controller.signal.reason
        if (reason instanceof BridgeRpcError) throw reason
        // The connection is gone; the abort only cancels upstream work.
        throw new BridgeRpcError(RPC_SERVER_ERROR, `command aborted: ${String(reason)}`, { code: 'command/aborted' })
      }
      throw error
    } finally {
      clearTimeout(timer)
      this.untrackInflight(connectionId, controller)
    }
  }

  // —— skill.* ——

  private async listSkills(params: unknown): Promise<unknown> {
    const sessionId = optionalString(params, 'sessionId')
    const skills = this.requireService(this.deps.getSkills(), 'skills')
    // With a session id, project-level skills resolve against that session's
    // header cwd; without one, against the process cwd.
    const options: SkillViewOptions = sessionId === undefined
      ? { cwd: process.cwd() }
      : await this.skillLookupOptions(sessionId)
    const summaries = await skills.list(options)
    return {
      // Only the stable catalog fields cross the wire; invocation policy,
      // provider locators, and resource bases stay host-side.
      skills: summaries.map((skill) => ({
        name: skill.name,
        description: skill.description,
        ...(skill.whenToUse === undefined ? {} : { whenToUse: skill.whenToUse }),
        source: skill.source,
        provider: skill.provider,
        ...(skill.path === undefined ? {} : { path: skill.path }),
      })),
    }
  }

  /** Header cwd of a live or stored session, for cwd-sensitive skill lookup. */
  private async skillLookupOptions(sessionId: string): Promise<SkillViewOptions> {
    const live = this.deps.sessions.get(asSessionId(sessionId))
    if (live !== undefined) {
      return live.header.cwd === undefined ? {} : { cwd: live.header.cwd }
    }
    const snapshot = await this.deps.sessionPersistence?.stat(asSessionId(sessionId))
    if (snapshot === undefined) {
      throw new BridgeRpcError(RPC_NOT_FOUND, `unknown session: ${sessionId}`, { code: 'session/not-found' })
    }
    return snapshot.header.cwd === undefined ? {} : { cwd: snapshot.header.cwd }
  }

  // —— session.exportZip ——

  private async exportSessionZip(params: unknown, connectionId: number): Promise<unknown> {
    const sessionId = requireString(params, 'sessionId')
    const destPath = optionalString(params, 'destPath')
    const sessionQuery = this.requireService(this.deps.getSessionQuery(), 'sessionQuery')
    const persistence = this.requireService(this.deps.sessionPersistence, 'sessionPersistence')
    const archive = await this.sessionLogExportModule()
    if (archive === undefined) {
      throw new BridgeRpcError(
        RPC_SERVICE_UNAVAILABLE,
        'session export module "@deepseek-ai/dsh-session-log-export" is not resolvable in this deployment',
        { code: 'service-unavailable', service: 'session-log-export' },
      )
    }
    const id = asSessionId(sessionId)
    // Mirrors upstream `sessionLogExportDeps(ctx)` from the injected/probed
    // services; a missing attachment store still exports attachment-free logs
    // and fails loud the moment a log actually references one.
    const deps: SessionLogExportReady = {
      sessionQuery,
      sessionPersistence: persistence,
      attachments: this.deps.getAttachments() ?? missingAttachments,
      sessions: this.deps.sessions,
    }
    const controller = new AbortController()
    this.trackInflight(connectionId, controller)
    let target: string | undefined
    let completed = false
    try {
      // Durability barrier for a live session before its log is read; a cold
      // id has no in-memory work and the flush is a no-op.
      await archive.flushLiveSessionLog(deps, id, controller.signal)
      const rootContent = await archive.readSessionLogText(persistence, id, controller.signal)
      if (rootContent === undefined) {
        throw new BridgeRpcError(RPC_NOT_FOUND, `unknown session: ${sessionId}`, { code: 'session/not-found' })
      }
      const fileName = archive.sessionLogZipFilename(sessionId)
      target = destPath ?? join(tmpdir(), 'dsh-session-export', fileName)
      await mkdir(dirname(target), { recursive: true })
      // The ZIP never touches the ndjson channel (no base64): bytes stream
      // straight to the host file, so large logs stay bounded in memory.
      const stream = archive.streamSessionLogZip(
        deps,
        rootContent,
        id,
        true,
        archive.DEFAULT_SESSION_LOG_COMPRESSION_LEVEL,
        controller.signal,
      )
      await pipeline(Readable.fromWeb(stream), createWriteStream(target))
      completed = true
      const stats = await stat(target)
      return { path: target, fileName, bytes: stats.size, entries: await zipEntryCount(target, stats.size) }
    } catch (error: unknown) {
      if (!completed && target !== undefined) {
        await unlink(target).catch(() => {}) // never leave a truncated archive behind
      }
      if (error instanceof BridgeRpcError) throw error
      if (controller.signal.aborted) {
        throw new BridgeRpcError(RPC_SERVER_ERROR, `session export aborted: ${String(controller.signal.reason)}`, { code: 'session-export/aborted' })
      }
      throw error
    } finally {
      this.untrackInflight(connectionId, controller)
    }
  }

  /**
   * First-call probe of the archive module, cached for the process lifetime.
   * The injected loader answers `undefined` for an unresolvable module (and
   * logs the cause); a throwing loader is contained and logged here, so the
   * probe can never break dispatch.
   */
  private sessionLogExportModule(): Promise<SessionLogExportModule | undefined> {
    this.sessionLogExportProbe ??= Promise.resolve()
      .then(() => this.deps.loadSessionLogExport())
      .then(
        (module) => {
          this.sessionLogExportResolved = module !== undefined
          return module
        },
        (error: unknown) => {
          this.sessionLogExportResolved = false
          this.deps.logger.warn(`dsh-vscode-bridge: session log export probe failed: ${String(error)}`)
          return undefined
        },
      )
    return this.sessionLogExportProbe
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

  /**
   * Resolve the live agent for one session: the same two-step lookup
   * `preset.current` performs, with `-32004` for a non-live session and
   * `-32009 session/no-agent` when the session has no running agent.
   */
  private requireLiveAgent(sessionId: string): Agent {
    const session = this.requireLiveSession(sessionId)
    const agent = this.deps.agents?.get(session.id)
    if (agent === undefined) {
      throw new BridgeRpcError(RPC_CONFLICT, `session ${sessionId} has no live agent`, { code: 'session/no-agent' })
    }
    return agent
  }

  private trackInflight(connectionId: number, controller: AbortController): void {
    let set = this.inflight.get(connectionId)
    if (set === undefined) {
      set = new Set()
      this.inflight.set(connectionId, set)
    }
    set.add(controller)
  }

  private untrackInflight(connectionId: number, controller: AbortController): void {
    const set = this.inflight.get(connectionId)
    if (set === undefined) return
    set.delete(controller)
    if (set.size === 0) this.inflight.delete(connectionId)
  }

  /** Abort every in-flight RPC of one closed connection. */
  private abortInflight(connectionId: number): void {
    const set = this.inflight.get(connectionId)
    if (set === undefined) return
    this.inflight.delete(connectionId)
    for (const controller of set) controller.abort()
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

/**
 * Attachment-store stand-in for deployments without one. Attachment-free logs
 * export normally; the first log referencing an attachment fails loud, never
 * silently under-exports.
 */
const missingAttachments: SessionLogExportReady['attachments'] = {
  readImage: () => {
    throw new Error('service "attachments" is not available in this profile')
  },
  readFileStream: () => {
    throw new Error('service "attachments" is not available in this profile')
  },
} as unknown as SessionLogExportReady['attachments']

/** End Of Central Directory record signature and fixed length (sans comment). */
const EOCD_SIGNATURE = 0x06054b50
const EOCD_RECORD_LENGTH = 22
/** The EOCD always sits within the last 22 + 65535 bytes (max comment). */
const EOCD_SEARCH_WINDOW = EOCD_RECORD_LENGTH + 0xffff

/**
 * Count the entries of a freshly written ZIP by scanning its tail for the End
 * Of Central Directory record. Only archives this process just produced are
 * read, and fflate writes a plain EOCD (no comment), so the record is found
 * immediately. ZIP64 archives (>= 0xFFFF entries, far beyond session-log
 * exports) are out of scope.
 */
async function zipEntryCount(path: string, size: number): Promise<number> {
  const handle = await open(path, 'r')
  try {
    const length = Math.min(size, EOCD_SEARCH_WINDOW)
    const tail = Buffer.alloc(length)
    await handle.read(tail, 0, length, size - length)
    for (let offset = length - EOCD_RECORD_LENGTH; offset >= 0; offset -= 1) {
      if (tail.readUInt32LE(offset) === EOCD_SIGNATURE) {
        return tail.readUInt16LE(offset + 10)
      }
    }
    throw new Error(`"${path}" is not a ZIP archive: end of central directory record missing`)
  } finally {
    await handle.close()
  }
}

function optionalNumber(params: unknown, field: string): number | undefined {
  const value = asRecord(params)[field]
  if (value === undefined) return undefined
  if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) {
    throw new BridgeRpcError(RPC_INVALID_PARAMS, `\`${field}\` must be a positive finite number when present`)
  }
  return value
}
