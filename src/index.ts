/**
 * dsh-vscode-bridge: a Cordis plugin that gives the dsh-vscode extension a
 * narrow, token-authenticated JSON-RPC channel into native DSH services.
 *
 * Capabilities (see the project PLAN, P4):
 * 1. Attach ACP-created sessions to their cwd's workspace, fixing the
 *    "ungrouped" section in the DSH Web UI (`workspaceRegistry`).
 * 2. Read/rename native session titles (`sessionTitle`).
 * 3. Archive sessions (the product-level delete, `workspaceRegistry`).
 * 4. List and switch agent presets (`agentPresets`, optional).
 * 5. Query and switch permission presets (`permissionPresets`).
 * 6. Push session events (plan/todo/title/permission) to subscribed clients.
 * 7. List and run native slash commands (`commands`, optional) — the same
 *    execution path the TUI/Web composers take.
 * 8. List the read-only skill catalog (`skills`, optional); invocation stays
 *    with the model-side skill tool.
 * 9. Export one session's log as a ZIP file on the host
 *    (`session.exportZip`, lazily resolved archive module).
 *
 * Discovery: the listener seat (host/port) plus a bearer token are written to
 * `$HOME/.dsh/vscode-bridge/<pid>.json` (mode 0600) and removed on unload;
 * the extension matches an instance via the payload's `directories` list.
 *
 * @module dsh-vscode-bridge
 */

import type { Context } from '@deepseek-ai/cordis'
import { randomBytes } from 'node:crypto'
import { homedir } from 'node:os'
import { join } from 'node:path'
import Schema from '@deepseek-ai/schemastery'
// Side-effect type imports: declaration-merge the consumed service keys and
// session events onto the cordis `Context`/`Events` interfaces.
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-session-persistence'
import type {} from '@deepseek-ai/dsh-session-title'
import type {} from '@deepseek-ai/dsh-workspace'
import type {} from '@deepseek-ai/dsh-permission-presets'
import type {} from '@deepseek-ai/dsh-agent-presets'
import type {} from '@deepseek-ai/dsh-commands'
import type {} from '@deepseek-ai/dsh-skill'
import { BridgeCore, type ResolvedBridgeConfig } from './core.ts'

export const name = 'dsh-vscode-bridge'

/**
 * Services guaranteed by the acp profile's dsh-base layer plus the two rows
 * the bridge profile patch inserts (`workspace`, and `permission` from base).
 * `agentPresets` stays optional and is resolved lazily through `ctx.get`.
 */
export const inject = [
  'sessions',
  'sessionPersistence',
  'sessionTitle',
  'workspaceRegistry',
  'permissionPresets',
  'agents',
]

/** Plugin configuration; every field optional thanks to schema defaults. */
export interface BridgePluginConfig {
  /** Bind address. Keep loopback: the discovery-file token is the boundary. */
  host?: string
  /** First candidate port (inclusive). */
  portStart?: number
  /** Last candidate port (inclusive). */
  portEnd?: number
  /** Fixed bearer token; a random one is generated when omitted. */
  token?: string
  /**
   * Directory holding the `<pid>.json` discovery file. Defaults to
   * `$HOME/.dsh/vscode-bridge`.
   */
  discoveryDir?: string
  /** Attach new sessions to their cwd's workspace on `session/created`. */
  attachSessions?: boolean
  /** `command.run` execution timeout; the in-flight command aborts past it. */
  commandTimeoutMs?: number
}

export const Config: Schema<BridgePluginConfig> = Schema.object({
  host: Schema.string().default('127.0.0.1'),
  portStart: Schema.natural().min(1).max(65535).default(7310),
  portEnd: Schema.natural().min(1).max(65535).default(7319),
  token: Schema.string(),
  discoveryDir: Schema.string(),
  attachSessions: Schema.boolean().default(true),
  commandTimeoutMs: Schema.natural().min(1).default(180000),
})

// Keep in sync with package.json#version (single source bump on release).
const PLUGIN_VERSION = '0.1.3'

/**
 * Mount the bridge. The Cordis wiring stays here; all behavior lives in
 * {@link BridgeCore} so it can be tested without a harness process.
 */
export function apply(ctx: Context, config: BridgePluginConfig): void {
  const logger = ctx.logger('dsh-vscode-bridge')
  const resolved: ResolvedBridgeConfig = {
    host: config.host ?? '127.0.0.1',
    portStart: config.portStart ?? 7310,
    portEnd: config.portEnd ?? 7319,
    token: config.token ?? randomToken(),
    discoveryDir: config.discoveryDir ?? join(homedir(), '.dsh', 'vscode-bridge'),
    attachSessions: config.attachSessions ?? true,
    commandTimeoutMs: config.commandTimeoutMs ?? 180000,
  }
  if (resolved.portEnd < resolved.portStart) {
    throw new Error(`dsh-vscode-bridge: portEnd (${resolved.portEnd}) is below portStart (${resolved.portStart})`)
  }

  const core = new BridgeCore({
    logger,
    config: resolved,
    version: PLUGIN_VERSION,
    sessions: ctx.sessions,
    sessionPersistence: ctx.sessionPersistence,
    sessionTitle: ctx.sessionTitle,
    workspaceRegistry: ctx.workspaceRegistry,
    permissionPresets: ctx.permissionPresets,
    agents: ctx.agents,
    getAgentPresets: () => ctx.get('agentPresets'),
    getCommands: () => ctx.get('commands'),
    getSkills: () => ctx.get('skills'),
    // Probed without their type-merge packages: the bridge only forwards the
    // values into the lazily imported archive module, which type-checks them.
    getSessionQuery: () => ctx.get('sessionQuery'),
    getAttachments: () => ctx.get('attachments'),
    loadSessionLogExport: async () => {
      try {
        return await import('@deepseek-ai/dsh-session-log-export')
      } catch (error: unknown) {
        logger.warn(`dsh-vscode-bridge: cannot resolve @deepseek-ai/dsh-session-log-export: ${String(error)}`)
        return undefined
      }
    },
  })

  ctx.on('session/created', (session) => {
    if (!resolved.attachSessions) return
    void core.attachSession(session)
  })
  ctx.on('session/event', (session, event) => {
    core.handleSessionEvent(session, event)
  })

  ctx.effect(() => {
    void core.start().catch((error: unknown) => {
      logger.warn(`startup failed: ${String(error)}`)
    })
    return async () => {
      await core.stop()
    }
  }, 'dsh-vscode-bridge lifecycle')
}

function randomToken(): string {
  // 192 bits of entropy; the discovery file is mode 0600 beside the workspace.
  return randomBytes(24).toString('hex')
}
