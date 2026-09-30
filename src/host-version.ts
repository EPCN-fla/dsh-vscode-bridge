/**
 * Host DSH version detection. The bridge runs inside the harness process,
 * but a production profile install carries only the plugin and its runtime
 * dependencies — the host's `@deepseek-ai/*` packages are not resolvable
 * from the plugin's own module path — so the version has to come from
 * in-process launch facts. Three sources are tried in order:
 *
 * 1. The launcher-provided `profileContext` service (DSH ≥ 0.1.7; absent on
 *    0.1.5). Its `installAnchor` is the absolute path of the owning dsh
 *    app's `package.json` — for the dsh CLI that manifest IS
 *    `@deepseek-ai/dsh`, so its `version` field is the DSH version.
 *    Packaged apps anchor at their own manifest instead, in which case the
 *    CLI (then a cohort package) is resolved from the anchor.
 * 2. The CLI entry in `process.argv[1]` — covers CLI-launched 0.1.5 hosts
 *    that provide no `profileContext`.
 * 3. Module resolution from the plugin's own location — development
 *    checkouts where the cohort packages are devDependencies.
 *
 * When none applies (custom compositions, some packaged hosts) the probe
 * reports `undefined` and the wire field is simply omitted — never guessed.
 *
 * @module dsh-vscode-bridge/host-version
 */

import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import type { BridgeTransportLogger } from './server.ts'

/**
 * Narrow structural slice of the launcher-provided `profileContext` service
 * (`@deepseek-ai/dsh-app-boot`; provided before the tree mounts on dsh
 * ≥ 0.1.7, absent on 0.1.5). Only the install anchor is consumed.
 */
export interface ProfileContextSlice {
  /** Absolute path of the owning dsh app's package.json. */
  readonly installAnchor?: string
}

export interface DetectDshVersionOptions {
  /** The launcher-provided profile context, when the host publishes one. */
  readonly profileContext?: ProfileContextSlice | undefined
  readonly logger?: BridgeTransportLogger
  /** CLI entry path; defaults to `process.argv[1]` (test seam). */
  readonly argvPath?: string
  /** Resolution base for the plugin-local fallback (test seam). */
  readonly moduleUrl?: string | URL
  /**
   * Resolver factory rooted at a base; defaults to `createRequire`. A test
   * seam: bare-specifier resolution walks ancestor `node_modules` into
   * shared directories, so tests jail it to their throwaway trees.
   */
  readonly requireFrom?: (base: string | URL) => NodeRequire
}

/**
 * The CLI manifest: its `version` IS the DSH release version. The cohort
 * package is the fallback witness — every `@deepseek-ai/dsh-*` package of a
 * release shares the version, and `dsh-agent` is a direct CLI dependency
 * (resolvable from the install root under any package-manager layout) as
 * well as the provider of the injected `agents` service.
 */
const CLI_PACKAGE = '@deepseek-ai/dsh'
const COHORT_PACKAGE = '@deepseek-ai/dsh-agent'

/** The default resolver factory. */
function defaultRequireFrom(base: string | URL): NodeRequire {
  return createRequire(base)
}

/** Normalize a base handed over as a `file://` URL string to a plain path. */
function asPath(base: string): string {
  return base.startsWith('file://') ? fileURLToPath(base) : base
}

/**
 * Probe the host DSH version once. Never throws and never fabricates: every
 * failure mode degrades to `undefined`, which the wire layer omits.
 */
export async function detectDshVersion(options: DetectDshVersionOptions = {}): Promise<string | undefined> {
  const requireFrom = options.requireFrom ?? defaultRequireFrom
  try {
    const anchor = options.profileContext?.installAnchor
    if (typeof anchor === 'string' && anchor.length > 0) {
      const fromAnchor = await versionFromAnchor(asPath(anchor), requireFrom)
      if (fromAnchor !== undefined) return report(options.logger, fromAnchor, 'profile install anchor')
    }
    const argvPath = options.argvPath ?? process.argv[1]
    if (typeof argvPath === 'string' && argvPath.length > 0) {
      const fromArgv = await versionByResolving(requireFrom(asPath(argvPath)), CLI_PACKAGE)
      if (fromArgv !== undefined) return report(options.logger, fromArgv, 'CLI entry path')
    }
    const ownRequire = requireFrom(options.moduleUrl ?? import.meta.url)
    const fromSelf = await versionByResolving(ownRequire, CLI_PACKAGE)
      ?? await versionByResolving(ownRequire, COHORT_PACKAGE)
    if (fromSelf !== undefined) return report(options.logger, fromSelf, 'plugin-local resolution')
  } catch { /* detection is best-effort; absence is a normal outcome */ }
  return undefined
}

/**
 * Read the anchor manifest: accepted directly when it is the CLI's own
 * `package.json`; otherwise (a packaged app's manifest) the CLI, then the
 * cohort witness, are resolved from the anchor's install tree.
 */
async function versionFromAnchor(anchor: string, requireFrom: (base: string | URL) => NodeRequire): Promise<string | undefined> {
  const direct = await versionFromManifest(anchor, CLI_PACKAGE)
  if (direct !== undefined) return direct
  const anchorRequire = requireFrom(anchor)
  return await versionByResolving(anchorRequire, CLI_PACKAGE)
    ?? await versionByResolving(anchorRequire, COHORT_PACKAGE)
}

/** Resolve `<pkg>/package.json` from a base and read its version. */
async function versionByResolving(require: NodeRequire, packageName: string): Promise<string | undefined> {
  let manifestPath: string
  try {
    manifestPath = require.resolve(`${packageName}/package.json`)
  } catch {
    return undefined // not reachable from this base
  }
  return await versionFromManifest(manifestPath)
}

/** Read a manifest's `version`, optionally pinning the expected `name`. */
async function versionFromManifest(path: string, expectedName?: string): Promise<string | undefined> {
  try {
    const manifest = JSON.parse(await readFile(path, 'utf8')) as { name?: unknown; version?: unknown }
    if (expectedName !== undefined && manifest.name !== expectedName) return undefined
    return typeof manifest.version === 'string' && manifest.version.length > 0 ? manifest.version : undefined
  } catch {
    return undefined
  }
}

function report(logger: BridgeTransportLogger | undefined, version: string, source: string): string {
  logger?.info(`dsh-vscode-bridge: host DSH version is ${version} (via ${source})`)
  return version
}
