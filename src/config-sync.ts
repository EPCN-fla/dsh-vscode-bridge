/** Import Web model routes and declarative presets into the active profile. */
import { createHash, randomUUID } from 'node:crypto'
import { readFile, realpath, lstat, open, rename, unlink } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { BridgeRpcError, RPC_CONFLICT, RPC_INVALID_PARAMS, RPC_SERVICE_UNAVAILABLE } from './protocol.ts'

/** Launcher facts needed for profile-local imports; no process-global home guesses. */
export interface ConfigSyncContext {
  readonly name: string
  readonly home: string
  readonly dir: string
  readonly patchPath: string
  readonly installAnchor: string
}

type Row = Record<string, unknown> & { id?: string; name?: string; config?: unknown }
/** Native, expression-preserving parser/composer supplied by the running host. */
export interface ConfigSyncHost {
  parse(path: string): Row[]
  compose(layers: Row[][]): Row[]
  bundleDir(name: string, profileDir: string): string
  dump(patches: Row[]): string
}

/** Resolve host tooling from the launcher anchor, keeping the host's Cordis singleton. */
export async function loadConfigSyncHost(context: ConfigSyncContext): Promise<ConfigSyncHost> {
  const require = createRequire(context.installAnchor)
  const bootPath = require.resolve('@deepseek-ai/dsh-app-boot')
  const boot = await import(pathToFileURL(bootPath).href) as {
    loadOverlayPatches(bin: string, path: string): Row[]
    composeEntries(layers: Row[][]): Row[]
    resolveBundleDir(bin: string, name: string, anchor: string, dir: string): string
  }
  const hostRequire = createRequire(bootPath)
  const include = await import(pathToFileURL(hostRequire.resolve('@deepseek-ai/cordis-plugin-include')).href) as { entryListSchema: unknown }
  const yaml = await import(pathToFileURL(hostRequire.resolve('js-yaml')).href) as {
    dump(value: unknown, options: Record<string, unknown>): string
  }
  return {
    parse: path => boot.loadOverlayPatches('dsh-vscode-bridge', path),
    compose: layers => boot.composeEntries(layers),
    bundleDir: (name, dir) => boot.resolveBundleDir('dsh-vscode-bridge', name, context.installAnchor, dir),
    dump: patches => yaml.dump(patches, { schema: include.entryListSchema, noRefs: true, lineWidth: -1 }),
  }
}

interface SyncOptions {
  models: boolean
  presets: boolean
  overwrite: boolean
}
interface Summary {
  source: 'web'
  target: string
  revision: string
  providers: string[]
  presets: string[]
  skipped: string[]
  supportRows: string[]
  changed: boolean
  restartRequired: boolean
}
interface Plan {
  summary: Summary
  patchText: string | undefined
  output: string
}

/** File import with explicit preview revisions, serialized writes and exact rollback copies. */
export class ConfigSync {
  private tail: Promise<unknown> = Promise.resolve()

  private readonly context: ConfigSyncContext
  private readonly host: ConfigSyncHost

  constructor(context: ConfigSyncContext, host: ConfigSyncHost) {
    this.context = context
    this.host = host
  }

  /** Preview exposes identifiers only; credentials and expressions never cross RPC. */
  async preview(params: unknown): Promise<Summary> {
    return (await this.plan(optionsOf(params))).summary
  }

  /** Apply precisely a reviewed generation; changing any input invalidates the preview. */
  import(params: unknown): Promise<Summary & { backupPath?: string }> {
    const args = record(params)
    const options = optionsOf(params)
    if (typeof args.revision !== 'string' || !/^[a-f0-9]{64}$/.test(args.revision)) {
      throw new BridgeRpcError(RPC_INVALID_PARAMS, 'revision from config.preview is required')
    }
    const revision = args.revision
    const task = this.tail.then(async () => {
      const lockPath = `${this.context.patchPath}.bridge-lock`
      let lock
      try { lock = await open(lockPath, 'wx', 0o600) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') conflict('config/import-busy', 'Another import owns the target patch lock')
        throw error
      }
      try {
        const plan = await this.plan(options)
        if (plan.summary.revision !== revision) conflict('config/stale-preview', 'Configuration changed; preview again')
        if (!plan.summary.changed) return plan.summary
        const path = this.context.patchPath
        const suffix = randomUUID()
        const backupPath = `${path}.bridge-backup-${suffix}`
        const temporary = `${path}.bridge-${suffix}.tmp`
        // Exclusive creates and mode 0600 protect inline credentials in both files.
        if (plan.patchText !== undefined) await exclusiveWrite(backupPath, plan.patchText)
        try {
          await exclusiveWrite(temporary, plan.output)
          const latest = await optionalText(path)
          if (latest !== plan.patchText) conflict('config/stale-preview', 'Target configuration changed; preview again')
          await rename(temporary, path)
        } finally {
          await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== 'ENOENT') throw error
          })
        }
        return { ...plan.summary, ...(plan.patchText === undefined ? {} : { backupPath }) }
      } finally {
        await lock.close()
        await unlink(lockPath)
      }
    })
    this.tail = task.catch(() => {})
    return task
  }

  private async plan(options: SyncOptions): Promise<Plan> {
    const context = this.context
    const sourceDir = join(context.home, 'profiles', 'web')
    const [sourceReal, targetReal] = await Promise.all([realpath(sourceDir), realpath(context.dir)])
    if (sourceReal === targetReal) conflict('config/same-profile', 'Web is already the active profile')
    if (resolve(context.patchPath) !== join(resolve(context.dir), 'cordis.patch.yml')) {
      conflict('config/unsupported-target', 'The active patch must be the profile cordis.patch.yml')
    }
    // Refuse patch symlinks: importing must not replace a file owned by another profile.
    for (const path of [join(sourceDir, 'cordis.patch.yml'), context.patchPath]) {
      const info = await lstat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined
        throw error
      })
      if (info !== undefined && (!info.isFile() || info.isSymbolicLink())) {
        conflict('config/linked-patch', 'Patch files must be regular files, not links')
      }
    }
    const inputs = new Map<string, string | undefined>()
    const text = async (path: string, optional = false): Promise<string | undefined> => {
      const value = optional ? await optionalText(path) : await readFile(path, 'utf8')
      inputs.set(path, value)
      return value
    }
    const patches = async (path: string, optional = false): Promise<Row[]> => {
      const value = await text(path, optional)
      return value === undefined ? [] : this.host.parse(path)
    }
    const profile = async (dir: string): Promise<{ rows: Row[]; patches: Row[] }> => {
      const manifest = record(JSON.parse((await text(join(dir, 'package.json'))) as string))
      const bundles = record(record(manifest.dsh).profile).bundles
      if (!Array.isArray(bundles) || !bundles.every(name => typeof name === 'string')) {
        conflict('config/invalid-profile', 'Profile must declare a bundle list')
      }
      const layers: Row[][] = []
      for (const name of bundles) {
        const bundleDir = this.host.bundleDir(name, dir)
        const metadata = record(JSON.parse((await text(join(bundleDir, 'package.json'))) as string))
        const declaration = record(record(metadata.dsh).bundle).patch
        const files = typeof declaration === 'string' ? [declaration] : declaration
        if (!Array.isArray(files) || !files.every(file => typeof file === 'string')) {
          conflict('config/invalid-bundle', 'Bundle must declare patch files')
        }
        for (const file of files) layers.push(await patches(resolve(bundleDir, file)))
      }
      const user = await patches(join(dir, 'cordis.patch.yml'), true)
      layers.push(user)
      return { rows: this.host.compose(layers), patches: user }
    }
    const source = await profile(sourceDir)
    const target = await profile(context.dir)
    // Home patches apply to both profiles; they remain shared and are not copied.
    const shared = await patches(join(context.home, 'cordis.patch.yml'), true)
    const sourceTop = this.host.compose([[{ insert: source.rows }], shared])
    const targetTop = this.host.compose([[{ insert: target.rows }], shared])
    const sourceRows = flatten(sourceTop)
    const targetRows = flatten(targetTop)
    for (const rows of [sourceRows, targetRows]) {
      const ids = new Set<string>()
      const presetIds = new Set<string>()
      for (const row of rows) {
        if (row.id !== undefined && ids.has(row.id)) conflict('config/duplicate-id', 'Profile contains duplicate row ids')
        if (row.id !== undefined) ids.add(row.id)
        if (row.name !== '@deepseek-ai/dsh-agent-preset') continue
        const id = record(row.config).id
        if (typeof id !== 'string' || presetIds.has(id)) conflict('config/duplicate-preset', 'Preset ids must be unique strings')
        presetIds.add(id)
      }
    }
    // Moving a row out of a group would lose its disabled/injection/isolation policy.
    for (const [rows, top] of [[sourceRows, sourceTop], [targetRows, targetTop]] as const) {
      if (rows.some(row => !top.includes(row) && ((options.models && row.id === 'llm-pi-ai')
        || (options.presets && row.name === '@deepseek-ai/dsh-agent-preset')))) {
        conflict('config/nested-row', 'Import supports top-level model and preset declarations only')
      }
    }
    const additions: Row[] = []
    const providers: string[] = []
    const presets: string[] = []
    const skipped: string[] = []
    const supportRows: string[] = []
    const patchRow = (row: Row, config: unknown): void => {
      if (typeof row.id !== 'string' || !row.id || typeof row.name !== 'string') conflict('config/missing-id', 'Imported rows must have stable ids and module names')
      const existing = targetRows.find(item => item.id === row.id)
      if (existing !== undefined && existing.name !== row.name) conflict('config/row-collision', `Target row ${row.id} belongs to another plugin`)
      additions.push(existing === undefined
        ? { insert: [{ ...row, config }] }
        : { id: row.id, name: row.name, config, disabled: row.disabled ?? false })
    }
    if (options.models) {
      const model = sourceRows.find(row => row.id === 'llm-pi-ai')
      if (model !== undefined) {
        if (model.name !== '@deepseek-ai/dsh-llm-pi-ai') conflict('config/model-row', 'llm-pi-ai does not name the native adapter')
        const config = record(model.config)
        const incoming = record(config.providers)
        const existing = targetRows.find(row => row.id === 'llm-pi-ai')
        const previous = record(existing?.config)
        const previousProviders = record(previous.providers)
        if (Object.hasOwn(incoming, '__jsExpr') || Object.hasOwn(previousProviders, '__jsExpr')) {
          conflict('config/dynamic-providers', 'Provider dictionaries must be literal mappings; expressions inside routes are preserved')
        }
        const merged = { ...previousProviders }
        for (const [id, value] of Object.entries(incoming)) {
          if (Object.hasOwn(merged, id) && !options.overwrite) { skipped.push(`provider:${id}`); continue }
          if (JSON.stringify(merged[id]) === JSON.stringify(value)) continue
          Object.defineProperty(merged, id, { value, enumerable: true, configurable: true, writable: true })
          providers.push(id)
        }
        if (providers.length) patchRow(existing === undefined ? model : { ...model, disabled: existing.disabled ?? false }, {
          ...(existing === undefined ? config : previous), providers: merged,
        })
      }
    }
    if (options.presets) {
      for (const row of sourceRows.filter(row => row.name === '@deepseek-ai/dsh-agent-preset')) {
        const id = record(row.config).id
        if (typeof id !== 'string' || !id) conflict('config/invalid-preset', 'Preset declarations require config.id')
        const existing = targetRows.find(item => item.name === row.name && record(item.config).id === id)
        if (existing !== undefined && !options.overwrite) { skipped.push(`preset:${id}`); continue }
        if (existing !== undefined && JSON.stringify(existing.config) === JSON.stringify(row.config)
          && existing.disabled === row.disabled) continue
        patchRow(existing === undefined ? row : { ...row, id: existing.id! }, row.config)
        presets.push(id)
      }
      if (presets.length) {
        // Registry and model-routing service are the host prerequisites of Web presets.
        const support = ['@deepseek-ai/dsh-agent-preset-registry', '@deepseek-ai/dsh-tool-subagent/model-selection-settings']
        const importsCordis = sourceRows.some(row => row.name === '@deepseek-ai/dsh-agent-preset'
          && presets.includes(String(record(row.config).id))
          && containsPlugin(record(row.config).plugins, '@deepseek-ai/dsh-tool-cordis'))
        if (importsCordis) support.push('@deepseek-ai/dsh-cordis-host-runner', '@deepseek-ai/dsh-tool-cordis/host')
        for (const name of support) {
          const row = sourceRows.find(item => item.name === name)
          if (row !== undefined && !targetRows.some(item => item.name === name)) {
            patchRow(row, row.config)
            supportRows.push(row.id!)
          }
        }
      }
    }
    // Verify higher-priority home patches cannot silently defeat the import.
    const resultRows = flatten(this.host.compose([[{ insert: target.rows }], additions, shared]))
    for (const addition of additions) {
      const expected = Array.isArray(addition.insert) ? addition.insert as Row[] : [addition]
      for (const row of expected) {
        const applied = resultRows.find(item => item.id === row.id)
        if (JSON.stringify(applied?.config) !== JSON.stringify(row.config)) {
          conflict('config/shared-override', `Shared home configuration overrides ${row.id}; edit the shared setting instead`)
        }
      }
    }
    // A target must already carry the modules referenced by imported presets.
    // This operation copies config, never installs packages or enables Web UI bundles.
    const inspect = (row: Row): void => {
      const name = row.name
      if (name && !name.startsWith('cordis:')) {
        if (name.startsWith('.') || name.startsWith('/') || name.startsWith('file:')) {
          conflict('config/local-plugin', 'Importing presets with filesystem plugin paths is unsupported')
        }
        const packageName = name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0]!
        try { this.host.bundleDir(packageName, context.dir) } catch {
          conflict('config/missing-package', `Install ${packageName} in the target profile before importing`)
        }
      }
      const config = row.config
      if (row.group === true && Array.isArray(config)) config.forEach(item => inspect(record(item)))
      const plugins = record(Array.isArray(config) ? undefined : config).plugins
      if (Array.isArray(plugins)) plugins.forEach(item => inspect(record(item)))
    }
    for (const addition of additions) {
      if (Array.isArray(addition.insert)) addition.insert.forEach(item => inspect(record(item)))
      else inspect(addition)
    }
    // Native parsers read their files synchronously; ensure no edit raced those reads.
    for (const [path, value] of inputs) {
      if (await optionalText(path) !== value) conflict('config/stale-preview', 'Configuration changed while reading; retry preview')
    }
    const revision = createHash('sha256').update(JSON.stringify([options, [...inputs]])).digest('hex')
    return {
      summary: { source: 'web', target: context.name, revision, providers, presets, skipped, supportRows,
        changed: additions.length > 0, restartRequired: additions.length > 0 },
      patchText: inputs.get(context.patchPath),
      output: this.host.dump([...target.patches, ...additions]),
    }
  }
}

function record(value: unknown): Record<string, unknown> {
  if (value === undefined || value === null) return {}
  if (typeof value !== 'object' || Array.isArray(value)) throw new BridgeRpcError(RPC_INVALID_PARAMS, 'Expected a configuration object')
  return value as Record<string, unknown>
}
function optionsOf(params: unknown): SyncOptions {
  const args = record(params)
  for (const key of Object.keys(args)) if (!['models', 'presets', 'overwrite', 'revision'].includes(key)) {
    throw new BridgeRpcError(RPC_INVALID_PARAMS, `Unknown import option: ${key}`)
  }
  for (const key of ['models', 'presets', 'overwrite']) if (args[key] !== undefined && typeof args[key] !== 'boolean') {
    throw new BridgeRpcError(RPC_INVALID_PARAMS, `${key} must be boolean`)
  }
  const options = { models: args.models !== false, presets: args.presets !== false, overwrite: args.overwrite === true }
  if (!options.models && !options.presets) throw new BridgeRpcError(RPC_INVALID_PARAMS, 'Select models or presets')
  return options
}
function containsPlugin(value: unknown, name: string): boolean {
  if (!Array.isArray(value)) return false
  return value.some(item => {
    const row = record(item)
    return row.name === name || (row.group === true && containsPlugin(row.config, name))
  })
}
function flatten(rows: Row[]): Row[] {
  return rows.flatMap(row => row.group === true && Array.isArray(row.config) ? [row, ...flatten(row.config)] : [row])
}
function conflict(code: string, message: string): never {
  throw new BridgeRpcError(RPC_CONFLICT, message, { code })
}
async function optionalText(path: string): Promise<string | undefined> {
  try { return await readFile(path, 'utf8') } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined
    throw error
  }
}
async function exclusiveWrite(path: string, text: string): Promise<void> {
  const file = await open(path, 'wx', 0o600)
  try { await file.writeFile(text, 'utf8'); await file.sync() } finally { await file.close() }
}

/** Resolve the optional importer lazily; failures reveal no parsed configuration values. */
export function createConfigSync(getContext: () => unknown): { available(): boolean; run(method: 'preview' | 'import', params: unknown): Promise<unknown> } {
  let importer: Promise<ConfigSync> | undefined
  const context = (): ConfigSyncContext | undefined => {
    const raw = getContext()
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined
    const { name, home, dir, patchPath, installAnchor } = record(raw)
    if (typeof name !== 'string' || !name || typeof home !== 'string' || !home
      || typeof dir !== 'string' || !dir || typeof patchPath !== 'string' || !patchPath
      || typeof installAnchor !== 'string' || !installAnchor) return undefined
    return { name, home, dir, patchPath, installAnchor }
  }
  return {
    available: () => context() !== undefined && context()?.name !== 'web',
    async run(method, params) {
      const current = context()
      if (current === undefined) throw new BridgeRpcError(RPC_SERVICE_UNAVAILABLE, 'Profile import requires a launcher profile', { code: 'service-unavailable', service: 'profileContext' })
      try {
        importer ??= loadConfigSyncHost(current).then(host => new ConfigSync(current, host))
        return await (await importer)[method](params)
      } catch (error) {
        if (error instanceof BridgeRpcError) throw error
        // YAML/JSON errors may include source lines containing API keys.
        throw new BridgeRpcError(RPC_SERVICE_UNAVAILABLE, 'Cannot read or write profile configuration; check profile files and host tooling', { code: 'config/unavailable' })
      }
    },
  }
}
