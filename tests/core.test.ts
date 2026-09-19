/**
 * BridgeCore tests: RPC auth/dispatch over real TCP against mocked harness
 * services, plus workspace-attach behavior and event push.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createConnection, type Socket } from 'node:net'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { existsSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BridgeCore, matchesEventType } from '../src/core.ts'
import type { BridgeCoreDeps } from '../src/core.ts'

const silent = { info() {}, warn() {}, error() {} }

// —— mocks ——

function makeSession(id: string, cwd?: string, parentSession?: string) {
  return {
    id,
    header: {
      version: 3,
      id,
      createdAt: 1_700_000_000_000,
      isSeeded: false,
      ...(cwd === undefined ? {} : { cwd }),
      ...(parentSession === undefined ? {} : { parentSession }),
    },
  }
}

function makeMocks() {
  const live = new Map<string, ReturnType<typeof makeSession>>()
  const calls = { attach: [] as string[], archive: [] as string[], renames: [] as string[], permissionSets: [] as string[], presetSelects: [] as string[] }
  const workspaces = new Map<string, { id: string; path: string; title: string; sessionIds: string[] }>()
  const mocks = {
    calls,
    workspaces,
    live,
    sessions: {
      list: () => [...live.values()],
      get: (id: string) => live.get(id),
    },
    sessionTitle: {
      get: (session: { id: string }) => ({ title: `title-of-${session.id}` }),
      rename: (session: { id: string }, title: string) => {
        calls.renames.push(`${session.id}=${title}`)
        return { title, updatedAt: 1_700_000_000_500 }
      },
    },
    workspaceRegistry: {
      list: () => [...workspaces.values()],
      archivedSessionIds: [] as string[],
      resolveByPath: async (path: string) => [...workspaces.values()].find((w) => w.path === path),
      create: async (path: string, title?: string) => {
        const workspace = { id: `ws-${workspaces.size + 1}`, path, title: title ?? path, sessionIds: [] as string[] }
        workspaces.set(workspace.id, workspace)
        return workspace
      },
      archiveSession: async (id: string) => {
        if (id === 'unknown') {
          const error = new Error(`unknown session ${id}`)
          error.name = 'WorkspaceUnknownSessionError'
          throw error
        }
        calls.archive.push(id)
      },
    },
    permissionPresets: {
      names: ['workspace-write', 'danger-full-access'],
      defaultPreset: 'workspace-write',
      optionOf: (name: string) => ({ value: name, name }),
      current: () => 'workspace-write',
      set: (_session: unknown, name: string) => {
        calls.permissionSets.push(name)
      },
    },
    agents: {
      get: (id: string) => (live.has(id) ? { id, ctx: { marker: 'agent-ctx' } } : undefined),
    },
    agentPresets: {
      defaultId: 'standard',
      list: async () => [
        { id: 'standard', trust: 'system', name: 'Standard' },
        { id: 'fast', trust: 'user', description: 'Fast model' },
      ],
      composedPreset: () => 'standard',
      select: async (_agent: unknown, presetId: string) => {
        calls.presetSelects.push(presetId)
        if (presetId === 'late') {
          const error = new Error('session has already started') as Error & { code: string; details: unknown }
          error.code = 'agent-preset/locked'
          error.details = { sessionId: 's1' }
          throw error
        }
        return presetId
      },
    },
  }
  return mocks
}

function makeDeps(overrides: Partial<BridgeCoreDeps> = {}): { deps: BridgeCoreDeps; mocks: ReturnType<typeof makeMocks>; discoveryDir: string } {
  const mocks = makeMocks()
  const discoveryDir = mkdtempSync(join(tmpdir(), 'dsh-bridge-discovery-'))
  const deps = {
    logger: silent,
    version: '0.1.0-test',
    config: {
      host: '127.0.0.1',
      portStart: 47450,
      portEnd: 47469,
      token: 'test-token',
      discoveryDir,
      attachSessions: true,
    },
    sessions: mocks.sessions,
    sessionTitle: mocks.sessionTitle,
    workspaceRegistry: mocks.workspaceRegistry,
    permissionPresets: mocks.permissionPresets,
    agents: mocks.agents,
    getAgentPresets: () => mocks.agentPresets,
    ...overrides,
  } as unknown as BridgeCoreDeps
  return { deps, mocks, discoveryDir }
}

// —— TCP client ——

class TestClient {
  private socket: Socket | undefined
  private buffer = ''
  private readonly waiting: ((message: Record<string, unknown>) => void)[] = []
  private readonly inbox: Record<string, unknown>[] = []

  async connect(port: number): Promise<void> {
    this.socket = createConnection({ host: '127.0.0.1', port })
    this.socket.on('data', (chunk) => {
      this.buffer += chunk.toString('utf8')
      for (;;) {
        const newline = this.buffer.indexOf('\n')
        if (newline < 0) break
        const line = this.buffer.slice(0, newline)
        this.buffer = this.buffer.slice(newline + 1)
        if (line.trim().length === 0) continue
        const message = JSON.parse(line)
        const waiter = this.waiting.shift()
        if (waiter === undefined) this.inbox.push(message)
        else waiter(message)
      }
    })
    await new Promise<void>((resolve) => this.socket?.once('connect', resolve))
  }

  /** Send one request and await its response (matched by order, fine for tests). Pass `null` to omit the token. */
  request(method: string, params?: unknown, token: string | null = 'test-token'): Promise<Record<string, unknown>> {
    const id = Math.floor(Math.random() * 1e9)
    const promise = new Promise<Record<string, unknown>>((resolve) => {
      this.waiting.push(resolve)
    })
    this.socket?.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, ...(params === undefined ? {} : { params }), ...(token === null ? {} : { token }) })}\n`)
    return promise
  }

  raw(line: string): Promise<Record<string, unknown>> {
    const promise = new Promise<Record<string, unknown>>((resolve) => {
      this.waiting.push(resolve)
    })
    this.socket?.write(`${line}\n`)
    return promise
  }

  /** Await the next server-initiated notification. */
  nextNotification(): Promise<Record<string, unknown>> {
    const queued = this.inbox.shift()
    if (queued !== undefined) return Promise.resolve(queued)
    return new Promise((resolve) => this.waiting.push(resolve))
  }

  close(): void {
    this.socket?.destroy()
  }
}

async function withCore(
  mocks: (deps: BridgeCoreDeps, mocks: ReturnType<typeof makeMocks>) => void,
  run: (core: BridgeCore, mocks: ReturnType<typeof makeMocks>) => Promise<void>,
): Promise<void> {
  const { deps, mocks: m, discoveryDir } = makeDeps()
  mocks(deps, m)
  const core = new BridgeCore(deps)
  await core.start()
  try {
    await run(core, m)
  } finally {
    await core.stop()
    await rm(discoveryDir, { recursive: true, force: true })
  }
}

// —— tests ——

test('handshake requires the token and reports capabilities', async () => {
  await withCore(() => {}, async (core) => {
    assert.notEqual(core.port, undefined)
    const client = new TestClient()
    await client.connect(core.port as number)
    const denied = await client.request('bridge.handshake', undefined, 'wrong')
    assert.equal((denied.error as { code: number }).code, -32001)
    const noToken = await client.request('bridge.handshake', undefined, null)
    assert.equal((noToken.error as { code: number }).code, -32001)
    const hello = await client.request('bridge.handshake')
    const result = hello.result as { plugin: string; capabilities: Record<string, boolean> }
    assert.equal(result.plugin, 'dsh-vscode-bridge')
    assert.deepEqual(result.capabilities, {
      workspaceGrouping: true,
      sessionTitle: true,
      sessionArchive: true,
      presets: true,
      permissions: true,
      eventPush: true,
    })
    client.close()
  })
})

test('malformed lines and unknown methods get structured errors', async () => {
  await withCore(() => {}, async (core) => {
    const client = new TestClient()
    await client.connect(core.port as number)
    const parse = await client.raw('not json')
    assert.equal((parse.error as { code: number }).code, -32700)
    assert.equal(parse.id, null)
    const missing = await client.request('nope.nothing', undefined)
    assert.equal((missing.error as { code: number }).code, -32601)
    client.close()
  })
})

test('session title, permission, and preset flows reach the native services', async () => {
  await withCore((deps, mocks) => {
    mocks.live.set('s1', makeSession('s1', '/tmp/project'))
    void deps
  }, async (core, mocks) => {
    const client = new TestClient()
    await client.connect(core.port as number)

    const list = await client.request('session.list')
    const rows = (list.result as { sessions: Record<string, unknown>[] }).sessions
    assert.equal(rows.length, 1)
    assert.equal(rows[0]?.sessionId, 's1')
    assert.equal(rows[0]?.title, 'title-of-s1')
    assert.equal(rows[0]?.permission, 'workspace-write')
    assert.equal(rows[0]?.agentPreset, 'standard')

    const renamed = await client.request('session.setTitle', { sessionId: 's1', title: 'My session' })
    assert.deepEqual(renamed.result, { sessionId: 's1', title: 'My session', updatedAt: 1_700_000_000_500 })
    assert.deepEqual(mocks.calls.renames, ['s1=My session'])

    const storedOnly = await client.request('session.setTitle', { sessionId: 'gone', title: 'x' })
    assert.equal((storedOnly.error as { code: number; data: { code: string } }).data.code, 'session/not-live')

    const permission = await client.request('permission.get', { sessionId: 's1' })
    const permissionResult = permission.result as { current: string; options: unknown[] }
    assert.equal(permissionResult.current, 'workspace-write')
    assert.equal(permissionResult.options.length, 2)

    const setPermission = await client.request('permission.set', { sessionId: 's1', name: 'danger-full-access' })
    assert.deepEqual(mocks.calls.permissionSets, ['danger-full-access'])
    assert.equal((setPermission.result as { current: string }).current, 'workspace-write')

    const badPermission = await client.request('permission.set', { sessionId: 's1', name: 'nope' })
    assert.equal((badPermission.error as { code: number }).code, -32602)

    const presets = await client.request('preset.list')
    const roster = presets.result as { default: string; presets: { id: string; isDefault: boolean }[] }
    assert.equal(roster.default, 'standard')
    assert.equal(roster.presets.length, 2)
    assert.equal(roster.presets[0]?.isDefault, true)

    const selected = await client.request('preset.select', { sessionId: 's1', presetId: 'fast' })
    assert.equal((selected.result as { selected: string }).selected, 'fast')
    assert.deepEqual(mocks.calls.presetSelects, ['fast'])

    const locked = await client.request('preset.select', { sessionId: 's1', presetId: 'late' })
    const lockedError = locked.error as { code: number; data: { code: string } }
    assert.equal(lockedError.code, -32009)
    assert.equal(lockedError.data.code, 'agent-preset/locked')

    const current = await client.request('preset.current', { sessionId: 's1' })
    assert.equal((current.result as { preset: string }).preset, 'standard')

    client.close()
  })
})

test('session.delete archives through the workspace registry', async () => {
  await withCore((deps, mocks) => {
    mocks.live.set('s1', makeSession('s1', '/tmp/project'))
    void deps
  }, async (core, mocks) => {
    const client = new TestClient()
    await client.connect(core.port as number)
    const deleted = await client.request('session.delete', { sessionId: 's1' })
    assert.deepEqual(deleted.result, { sessionId: 's1', archived: true })
    assert.deepEqual(mocks.calls.archive, ['s1'])
    const unknown = await client.request('session.delete', { sessionId: 'unknown' })
    assert.equal((unknown.error as { code: number }).code, -32004)
    client.close()
  })
})

test('subscribers receive matching session events only', async () => {
  await withCore((deps, mocks) => {
    mocks.live.set('s1', makeSession('s1', '/tmp/project'))
    mocks.live.set('s2', makeSession('s2', '/tmp/project'))
    void deps
  }, async (core, mocks) => {
    const client = new TestClient()
    await client.connect(core.port as number)
    await client.request('session.subscribe', { sessionId: 's1', types: ['session/title', 'plan/'] })
    const s1 = mocks.live.get('s1')
    const s2 = mocks.live.get('s2')
    assert.notEqual(s1, undefined)
    assert.notEqual(s2, undefined)

    core.handleSessionEvent(s2 as never, { type: 'session/title', seq: 5, time: 1, data: { title: 'other' } } as never)
    core.handleSessionEvent(s1 as never, { type: 'sandbox/mode', seq: 6, time: 2, data: {} } as never)
    core.handleSessionEvent(s1 as never, { type: 'session/title', seq: 7, time: 3, data: { title: 'new' } } as never)

    const notification = await client.nextNotification()
    assert.equal(notification.method, 'bridge.event')
    const params = notification.params as { sessionId: string; event: { type: string; data: { title: string } } }
    assert.equal(params.sessionId, 's1')
    assert.equal(params.event.type, 'session/title')
    assert.equal(params.event.data.title, 'new')
    client.close()
  })
})

test('matchesEventType supports exact, prefix, and wildcard patterns', () => {
  assert.equal(matchesEventType(['session/title'], 'session/title'), true)
  assert.equal(matchesEventType(['session/title'], 'session/other'), false)
  assert.equal(matchesEventType(['plan/'], 'plan/update'), true)
  assert.equal(matchesEventType(['plan/'], 'todo/update'), false)
  assert.equal(matchesEventType(['*'], 'anything/at-all'), true)
  assert.equal(matchesEventType([], 'session/title'), false)
})

test('attachSession groups by cwd, skips subagents and cwd-less sessions', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bridge-attach-'))
  try {
    const { deps, mocks, discoveryDir } = makeDeps()
    // Entity behavior: attachSession prepends into sessionIds.
    const originalCreate = mocks.workspaceRegistry.create
    mocks.workspaceRegistry.create = async (path: string, title?: string) => {
      const workspace = await originalCreate(path, title)
      ;(workspace as { attachSession?: unknown }).attachSession = async (id: string) => {
        mocks.calls.attach.push(id)
        workspace.sessionIds.unshift(id)
      }
      return workspace
    }
    const core = new BridgeCore(deps)
    await core.start()
    try {
      const subagent = await core.attachSession(makeSession('child', root, 'parent') as never)
      assert.equal(subagent.attached, false)
      assert.equal(subagent.reason, 'subagent')

      const noCwd = await core.attachSession(makeSession('nocwd') as never)
      assert.equal(noCwd.attached, false)
      assert.equal(noCwd.reason, 'no-cwd')

      const attached = await core.attachSession(makeSession('s1', root) as never)
      assert.equal(attached.attached, true)
      assert.deepEqual(mocks.calls.attach, ['s1'])

      // Second session with the same cwd reuses the workspace (no new create).
      const again = await core.attachSession(makeSession('s2', root) as never)
      assert.equal(again.workspaceId, attached.workspaceId)

      // Already a member: idempotent, no duplicate mutation.
      const repeat = await core.attachSession(makeSession('s1', root) as never)
      assert.equal(repeat.reason, 'already')

      // The discovery file advertises the session cwd it was published for.
      const entry = JSON.parse(await readFile(join(discoveryDir, `${process.pid}.json`), 'utf8')) as { directories: string[] }
      assert.ok(entry.directories.includes(root))
    } finally {
      await core.stop()
    }
    // Discovery file lives in the discovery dir only and is removed on stop.
    assert.equal(existsSync(join(discoveryDir, `${process.pid}.json`)), false)
    assert.equal(existsSync(join(root, '.dsh-bridge.json')), false)
    await rm(discoveryDir, { recursive: true, force: true })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('degraded services report capabilities honestly', async () => {
  await withCore((deps) => {
    const mutable = deps as unknown as Record<string, unknown>
    delete mutable.workspaceRegistry
    delete mutable.sessionTitle
    delete mutable.permissionPresets
    mutable.getAgentPresets = () => undefined
  }, async (core) => {
    const client = new TestClient()
    await client.connect(core.port as number)
    const hello = await client.request('bridge.handshake')
    const capabilities = (hello.result as { capabilities: Record<string, boolean> }).capabilities
    assert.deepEqual(capabilities, {
      workspaceGrouping: false,
      sessionTitle: false,
      sessionArchive: false,
      presets: false,
      permissions: false,
      eventPush: true,
    })
    const presetList = await client.request('preset.list')
    assert.equal((presetList.error as { code: number; data: { code: string } }).data.code, 'service-unavailable')
    const permission = await client.request('permission.get')
    assert.equal((permission.error as { code: number; data: { code: string } }).data.code, 'service-unavailable')
    client.close()
  })
})
