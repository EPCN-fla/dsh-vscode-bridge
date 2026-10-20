/**
 * Discovery file management: the bridge publishes a single
 * `<discoveryDir>/<pid>.json` (default `$HOME/.dsh/vscode-bridge`) holding
 * host/port/token plus the directories this instance serves. The VS Code
 * extension scans that one directory and picks the entry whose
 * `directories` contain the folder it opened — nothing is written into
 * workspaces anymore. The file is mode 0600, removed on unload, and a
 * startup sweep reaps entries left behind by dead processes.
 *
 * @module dsh-vscode-bridge/discovery
 */

import { chmod, mkdir, readdir, rename, unlink, writeFile } from 'node:fs/promises'
import { unlinkSync } from 'node:fs'
import { join } from 'node:path'
import type { DiscoveryFilePayload } from './protocol.ts'
import type { BridgeTransportLogger } from './server.ts'

/** Discovery entries are named `<pid>.json`; anything else is left alone. */
const ENTRY_PATTERN = /^(\d+)\.json$/

/**
 * Owns this process's single discovery file. Embedding the pid in the file
 * name lets concurrent DSH instances coexist and makes stale entries
 * identifiable by a liveness check.
 */
export class DiscoveryFile {
  private readonly deps: {
    readonly directory: string
    readonly logger: BridgeTransportLogger
  }
  private published = false
  private closing = false
  private writes: Promise<void> = Promise.resolve()

  constructor(deps: {
    readonly directory: string
    readonly logger: BridgeTransportLogger
  }) {
    this.deps = deps
  }

  /** The file this instance publishes: `<directory>/<pid>.json`. */
  get path(): string {
    return join(this.deps.directory, `${process.pid}.json`)
  }

  /** Paths currently published (for diagnostics). */
  get paths(): readonly string[] {
    return this.published ? [this.path] : []
  }

  /**
   * Write or atomically replace this instance's discovery file. The
   * directory is created on demand mode 0700 — it holds bearer tokens.
   */
  publish(payload: DiscoveryFilePayload): Promise<void> {
    if (this.closing) return Promise.resolve()
    const body = `${JSON.stringify(payload, null, 2)}\n`
    const task = this.writes.then(async () => {
      if (this.closing) return
      await mkdir(this.deps.directory, { recursive: true, mode: 0o700 })
      const target = this.path
      const temporary = `${target}.tmp-${process.pid}`
      try {
        await writeFile(temporary, body, { encoding: 'utf8', mode: 0o600 })
        await chmod(temporary, 0o600)
        if (this.closing) return
        await rename(temporary, target)
        this.published = true
      } finally {
        await unlink(temporary).catch((error: NodeJS.ErrnoException) => {
          if (error.code !== 'ENOENT') throw error
        })
      }
    })
    this.writes = task.catch(() => {})
    return task
  }

  /** Remove this instance's file. Called on plugin disposal. */
  async clear(): Promise<void> {
    this.closing = true
    await this.writes
    try {
      await unlink(this.path)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') {
        this.deps.logger.warn(`dsh-vscode-bridge: cannot remove discovery file ${this.path}: ${String(error)}`)
      }
    }
    this.published = false
  }

  /** Synchronous best-effort cleanup for the process `exit` hook. */
  clearSync(): void {
    this.closing = true
    for (const path of [this.path, `${this.path}.tmp-${process.pid}`]) {
      try {
        unlinkSync(path)
      } catch { /* already gone — nothing to retract */ }
    }
    this.published = false
  }

  /**
   * Reap `<pid>.json` entries whose process is gone — crash leftovers the
   * exit hook never got to remove. Live instances and foreign files are
   * left untouched.
   */
  async sweepStale(): Promise<void> {
    let entries: string[]
    try {
      entries = await readdir(this.deps.directory)
    } catch {
      return // directory does not exist yet — nothing to reap
    }
    for (const entry of entries) {
      const match = ENTRY_PATTERN.exec(entry)
      const pidText = match?.[1]
      if (pidText === undefined) continue
      const pid = Number(pidText)
      if (pid === process.pid || isAlive(pid)) continue
      try {
        await unlink(join(this.deps.directory, entry))
        this.deps.logger.info(`dsh-vscode-bridge: reaped stale discovery file ${entry}`)
      } catch (error: unknown) {
        this.deps.logger.warn(`dsh-vscode-bridge: cannot reap stale discovery file ${entry}: ${String(error)}`)
      }
    }
  }
}

/** Best-effort liveness check; EPERM means the pid exists but is not ours. */
function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
