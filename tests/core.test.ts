/**
 * BridgeCore tests: RPC auth/dispatch over real TCP against mocked harness
 * services, plus workspace-attach behavior and event push.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createConnection, type Socket } from 'node:net'
import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
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
  const calls = {
    attach: [] as string[],
    archive: [] as string[],
    renames: [] as string[],
    permissionSets: [] as string[],
    presetSelects: [] as string[],
    flushes: [] as string[],
    commandRuns: [] as { agentId: string; line: string; attachments: number }[],
    commandAborts: [] as string[],
    skillLookups: [] as { cwd?: string }[],
    exportFlushes: [] as string[],
    exportStreams: [] as { id: string; includeDescendants: boolean; level: number }[],
  }
  const workspaces = new Map<string, { id: string; path: string; title: string; sessionIds: string[] }>()
  // Stored log texts keyed by session id; the mock persistence/archive read them.
  const exportLogs = new Map<string, string>()
  const mocks = {
    calls,
    workspaces,
    live,
    exportLogs,
    sessions: {
      list: () => [...live.values()],
      get: (id: string) => live.get(id),
      flush: async (session: { id: string }) => {
        calls.flushes.push(session.id)
        return true
      },
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
    commands: {
      list: (agent: { id: string }) => [
        { name: 'compact', description: 'Compact the conversation', input: { hint: 'Optional compaction focus' } },
        { name: 'export', description: 'Download this Session log as a ZIP archive' },
        { name: 'plan', description: 'Toggle plan mode', input: { hint: 'Optional plan', attachments: true } },
      ],
      execute: (agent: { id: string }, line: string, attachments: unknown[], signal: AbortSignal) => {
        calls.commandRuns.push({ agentId: agent.id, line, attachments: attachments.length })
        if (line === '/unknown') return Promise.resolve(undefined)
        if (line === '/busy') return Promise.resolve({ commandId: 'cmd-busy', result: { kind: 'error', text: 'session is busy' } })
        if (line === '/hang') {
          return new Promise((_resolve, reject) => {
            signal.addEventListener('abort', () => {
              calls.commandAborts.push(line)
              reject(signal.reason)
            }, { once: true })
          })
        }
        return Promise.resolve({ commandId: 'cmd-1', result: { kind: 'success', text: `ran ${line}`, sourceEventSeq: 42 } })
      },
    },
    skills: {
      list: async (options?: { cwd?: string }) => {
        calls.skillLookups.push(options ?? {})
        return [
          {
            name: 'pdf-tools',
            description: 'Read and write PDF files',
            whenToUse: 'When a PDF needs parsing',
            invocation: { modelInvocable: true, userInvocable: true },
            source: 'project-dsh',
            provider: 'filesystem',
            path: '/tmp/project/.dsh/skills/pdf-tools/SKILL.md',
            resourceBase: { kind: 'directory', path: '/tmp/project/.dsh/skills/pdf-tools' },
          },
          { name: 'review', description: 'Code review checklist', invocation: { modelInvocable: true, userInvocable: false }, source: 'user-dsh', provider: 'filesystem' },
        ]
      },
    },
    sessionQuery: {
      traceSession: async () => ({ descendants: [] }),
    },
    // Mock archive module mirroring the @deepseek-ai/dsh-session-log-export surface.
    exportModule: {
      DEFAULT_SESSION_LOG_COMPRESSION_LEVEL: 6,
      sessionLogZipFilename: (id: string) => `dsh-session-${id.replace(/[^A-Za-z0-9_-]/g, '_')}.zip`,
      flushLiveSessionLog: async (deps: { sessions?: { get: (id: string) => unknown; flush?: (session: unknown) => Promise<unknown> } }, id: string) => {
        calls.exportFlushes.push(id)
        const session = deps.sessions?.get(id)
        if (session !== undefined) await deps.sessions?.flush?.(session)
      },
      readSessionLogText: async (_persistence: unknown, id: string) => exportLogs.get(id),
      streamSessionLogZip: (
        _deps: unknown,
        rootContent: string,
        id: string,
        includeDescendants: boolean,
        level: number,
        signal: AbortSignal,
      ) => {
        calls.exportStreams.push({ id, includeDescendants, level })
        if (id === 'stream-fails') {
          return new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('PK partial'))
              controller.error(new Error('stream boom'))
            },
          })
        }
        if (id === 'never-ends') {
          return new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('PK partial'))
              signal.addEventListener('abort', () => controller.error(signal.reason), { once: true })
            },
          })
        }
        const zip = buildStoredZip([
          { name: 'session.v3.jsonl', content: new TextEncoder().encode(rootContent) },
          { name: 'media/att-1.png', content: new Uint8Array([1, 2, 3]) },
        ])
        return new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(zip)
            controller.close()
          },
        })
      },
    },
  }
  return mocks
}

// —— minimal stored-ZIP builder (uncompressed entries) for the mock archive ——

const CRC_TABLE = new Uint32Array(256).map((_, n) => {
  let c = n
  for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
  return c >>> 0
})

function crc32(data: Uint8Array): number {
  let crc = 0xffffffff
  for (const byte of data) crc = (CRC_TABLE[(crc ^ byte) & 0xff] as number) ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** Build a valid uncompressed ZIP so the EOCD entry count can be read back. */
function buildStoredZip(entries: readonly { name: string; content: Uint8Array }[]): Uint8Array {
  const encoder = new TextEncoder()
  const chunks: Uint8Array[] = []
  const central: Uint8Array[] = []
  let offset = 0
  for (const entry of entries) {
    const name = encoder.encode(entry.name)
    const crc = crc32(entry.content)
    const local = new DataView(new ArrayBuffer(30))
    local.setUint32(0, 0x04034b50, true)
    local.setUint16(4, 20, true)
    local.setUint32(14, crc, true)
    local.setUint32(18, entry.content.byteLength, true)
    local.setUint32(22, entry.content.byteLength, true)
    local.setUint16(26, name.byteLength, true)
    chunks.push(new Uint8Array(local.buffer), name, entry.content)
    const record = new DataView(new ArrayBuffer(46))
    record.setUint32(0, 0x02014b50, true)
    record.setUint16(4, 20, true)
    record.setUint16(6, 20, true)
    record.setUint32(16, crc, true)
    record.setUint32(20, entry.content.byteLength, true)
    record.setUint32(24, entry.content.byteLength, true)
    record.setUint16(28, name.byteLength, true)
    record.setUint32(42, offset, true)
    central.push(new Uint8Array(record.buffer), name)
    offset += 30 + name.byteLength + entry.content.byteLength
  }
  const centralStart = offset
  const centralSize = central.reduce((total, chunk) => total + chunk.byteLength, 0)
  const eocd = new DataView(new ArrayBuffer(22))
  eocd.setUint32(0, 0x06054b50, true)
  eocd.setUint16(8, entries.length, true)
  eocd.setUint16(10, entries.length, true)
  eocd.setUint32(12, centralSize, true)
  eocd.setUint32(16, centralStart, true)
  const body = [...chunks, ...central, new Uint8Array(eocd.buffer)]
  const size = body.reduce((total, chunk) => total + chunk.byteLength, 0)
  const zip = new Uint8Array(size)
  let at = 0
  for (const chunk of body) {
    zip.set(chunk, at)
    at += chunk.byteLength
  }
  return zip
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
      commandTimeoutMs: 180000,
    },
    sessions: mocks.sessions,
    sessionTitle: mocks.sessionTitle,
    workspaceRegistry: mocks.workspaceRegistry,
    permissionPresets: mocks.permissionPresets,
    agents: mocks.agents,
    getAgentPresets: () => mocks.agentPresets,
    getCommands: () => mocks.commands,
    getSkills: () => mocks.skills,
    getSessionQuery: () => mocks.sessionQuery,
    getAttachments: () => undefined,
    loadSessionLogExport: async () => mocks.exportModule,
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
      commands: true,
      skills: true,
      sessionExport: true,
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

test('workspace.attach also attaches stored (non-live) sessions by header cwd', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bridge-attach-stored-'))
  try {
    await withCore((deps, mocks) => {
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
      // Sessions created by a spawned ACP host are stored but never live here.
      const stored = new Map<string, unknown>([
        ['stored-1', { header: { version: 3, id: 'stored-1', createdAt: 1, isSeeded: false, cwd: root }, revision: 'r1' }],
        ['stored-child', { header: { version: 3, id: 'stored-child', createdAt: 1, isSeeded: false, cwd: root, parentSession: 'stored-1' }, revision: 'r1' }],
        ['stored-nocwd', { header: { version: 3, id: 'stored-nocwd', createdAt: 1, isSeeded: false }, revision: 'r1' }],
      ])
      ;(deps as unknown as Record<string, unknown>).sessionPersistence = {
        stat: async (id: string) => stored.get(id),
      }
      mocks.live.set('live-1', makeSession('live-1', root))
    }, async (core, mocks) => {
      const client = new TestClient()
      await client.connect(core.port as number)

      // Live session: the pre-existing path still attaches.
      const live = await client.request('workspace.attach', { sessionId: 'live-1' })
      assert.equal((live.result as { attached: boolean }).attached, true)
      assert.deepEqual(mocks.calls.attach, ['live-1'])

      // Stored session: resolved through persistence, grouped by the same cwd.
      const stored = await client.request('workspace.attach', { sessionId: 'stored-1' })
      const storedResult = stored.result as { attached: boolean; workspaceId: string }
      assert.equal(storedResult.attached, true)
      assert.equal(storedResult.workspaceId, (live.result as { workspaceId: string }).workspaceId)
      assert.deepEqual(mocks.calls.attach, ['live-1', 'stored-1'])

      // Already a member: idempotent, no duplicate mutation.
      const repeat = await client.request('workspace.attach', { sessionId: 'stored-1' })
      assert.equal((repeat.result as { reason: string }).reason, 'already')

      // Stored subagent and cwd-less sessions refuse like the live path.
      const child = await client.request('workspace.attach', { sessionId: 'stored-child' })
      assert.equal((child.result as { reason: string }).reason, 'subagent')
      const noCwd = await client.request('workspace.attach', { sessionId: 'stored-nocwd' })
      assert.equal((noCwd.result as { reason: string }).reason, 'no-cwd')

      // Neither live nor stored: not found.
      const missing = await client.request('workspace.attach', { sessionId: 'missing' })
      assert.equal((missing.error as { data: { code: string } }).data.code, 'session/not-found')

      client.close()
    })
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
    mutable.getCommands = () => undefined
    mutable.getSkills = () => undefined
    mutable.getSessionQuery = () => undefined
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
      commands: false,
      skills: false,
      sessionExport: false,
      eventPush: true,
    })
    const presetList = await client.request('preset.list')
    assert.equal((presetList.error as { code: number; data: { code: string } }).data.code, 'service-unavailable')
    const permission = await client.request('permission.get')
    assert.equal((permission.error as { code: number; data: { code: string } }).data.code, 'service-unavailable')
    client.close()
  })
})

test('command.list maps the native catalog for a live session agent', async () => {
  await withCore((deps, mocks) => {
    mocks.live.set('s1', makeSession('s1', '/tmp/project'))
    void deps
  }, async (core) => {
    const client = new TestClient()
    await client.connect(core.port as number)

    const listed = await client.request('command.list', { sessionId: 's1' })
    const commands = (listed.result as { commands: Record<string, unknown>[] }).commands
    assert.deepEqual(commands, [
      { name: 'compact', description: 'Compact the conversation', inputHint: 'Optional compaction focus' },
      { name: 'export', description: 'Download this Session log as a ZIP archive' },
      { name: 'plan', description: 'Toggle plan mode', inputHint: 'Optional plan', attachments: true },
    ])

    // A non-live session cannot resolve an agent.
    const stored = await client.request('command.list', { sessionId: 'gone' })
    assert.equal((stored.error as { code: number; data: { code: string } }).data.code, 'session/not-live')
    client.close()
  })
})

test('command.list degrades without the commands service', async () => {
  await withCore((deps, mocks) => {
    mocks.live.set('s1', makeSession('s1', '/tmp/project'))
    ;(deps as unknown as Record<string, unknown>).getCommands = () => undefined
  }, async (core) => {
    const client = new TestClient()
    await client.connect(core.port as number)
    const listed = await client.request('command.list', { sessionId: 's1' })
    const error = listed.error as { code: number; data: { code: string; service: string } }
    assert.equal(error.code, -32002)
    assert.equal(error.data.code, 'service-unavailable')
    assert.equal(error.data.service, 'commands')
    client.close()
  })
})

test('command.run executes through the native registry and shapes the upstream result', async () => {
  await withCore((deps, mocks) => {
    mocks.live.set('s1', makeSession('s1', '/tmp/project'))
    void deps
  }, async (core, mocks) => {
    const client = new TestClient()
    await client.connect(core.port as number)

    const ran = await client.request('command.run', { sessionId: 's1', line: '/plan' })
    assert.deepEqual(ran.result, { commandId: 'cmd-1', kind: 'success', text: 'ran /plan', sourceEventSeq: 42 })
    // The agent of that exact session, an empty attachment channel, one signal.
    assert.deepEqual(mocks.calls.commandRuns, [{ agentId: 's1', line: '/plan', attachments: 0 }])

    // Handler-level failure arrives as a kind:'error' result, not an RPC error.
    const busy = await client.request('command.run', { sessionId: 's1', line: '/busy' })
    assert.deepEqual(busy.result, { commandId: 'cmd-busy', kind: 'error', text: 'session is busy' })

    // Not a slash command: rejected before the registry is consulted.
    const plain = await client.request('command.run', { sessionId: 's1', line: 'plan' })
    assert.equal((plain.error as { code: number }).code, -32602)

    // Syntactically a command but unresolvable: upstream `undefined` maps to -32602.
    const unknown = await client.request('command.run', { sessionId: 's1', line: '/unknown' })
    const unknownError = unknown.error as { code: number; data: { code: string } }
    assert.equal(unknownError.code, -32602)
    assert.equal(unknownError.data.code, 'command/unknown')

    // Bad timeout values are params errors.
    const badTimeout = await client.request('command.run', { sessionId: 's1', line: '/plan', timeoutMs: -5 })
    assert.equal((badTimeout.error as { code: number }).code, -32602)

    const stored = await client.request('command.run', { sessionId: 'gone', line: '/plan' })
    assert.equal((stored.error as { data: { code: string } }).data.code, 'session/not-live')
    client.close()
  })
})

test('command.run aborts at the timeout with command/timeout', async () => {
  await withCore((deps, mocks) => {
    mocks.live.set('s1', makeSession('s1', '/tmp/project'))
    ;(deps.config as { commandTimeoutMs: number }).commandTimeoutMs = 60
  }, async (core, mocks) => {
    const client = new TestClient()
    await client.connect(core.port as number)
    const started = Date.now()
    const timedOut = await client.request('command.run', { sessionId: 's1', line: '/hang' })
    assert.ok(Date.now() - started < 5000, 'the RPC answered at the timeout, not at handler settlement')
    const error = timedOut.error as { code: number; data: { code: string } }
    assert.equal(error.code, -32000)
    assert.equal(error.data.code, 'command/timeout')
    assert.deepEqual(mocks.calls.commandAborts, ['/hang'])
    client.close()
  })
})

test('command.run aborts in-flight executions when the connection drops', async () => {
  await withCore((deps, mocks) => {
    mocks.live.set('s1', makeSession('s1', '/tmp/project'))
    void deps
  }, async (core, mocks) => {
    const client = new TestClient()
    await client.connect(core.port as number)
    // Never awaited: the response dies with the connection.
    void client.request('command.run', { sessionId: 's1', line: '/hang' })
    await waitFor(() => mocks.calls.commandRuns.length === 1)
    client.close()
    await waitFor(() => mocks.calls.commandAborts.length === 1)
    assert.deepEqual(mocks.calls.commandAborts, ['/hang'])
  })
})

test('default subscriptions push command/ lifecycle events', async () => {
  await withCore((deps, mocks) => {
    mocks.live.set('s1', makeSession('s1', '/tmp/project'))
    void deps
  }, async (core, mocks) => {
    const client = new TestClient()
    await client.connect(core.port as number)
    const subscribed = await client.request('session.subscribe', { sessionId: 's1' })
    const types = (subscribed.result as { types: string[] }).types
    assert.ok(types.includes('command/'), 'default push types carry the command/ prefix')

    const s1 = mocks.live.get('s1')
    assert.notEqual(s1, undefined)
    core.handleSessionEvent(s1 as never, { type: 'command/run', seq: 9, time: 1, data: { commandId: 'c1', name: 'plan', source: { kind: 'user' } } } as never)
    core.handleSessionEvent(s1 as never, { type: 'command/done', seq: 10, time: 2, data: { commandId: 'c1', kind: 'success' } } as never)

    const run = await client.nextNotification()
    assert.equal((run.params as { event: { type: string } }).event.type, 'command/run')
    const done = await client.nextNotification()
    assert.equal((done.params as { event: { type: string } }).event.type, 'command/done')
    client.close()
  })
})

test('skill.list maps stable catalog fields and resolves the lookup cwd', async () => {
  await withCore((deps, mocks) => {
    mocks.live.set('s1', makeSession('s1', '/tmp/project'))
    ;(deps as unknown as Record<string, unknown>).sessionPersistence = {
      stat: async (id: string) => (id === 'stored-1'
        ? { header: { version: 3, id: 'stored-1', createdAt: 1, isSeeded: false, cwd: '/tmp/stored-project' }, revision: 'r1' }
        : undefined),
    }
  }, async (core, mocks) => {
    const client = new TestClient()
    await client.connect(core.port as number)

    const listed = await client.request('skill.list', { sessionId: 's1' })
    const skills = (listed.result as { skills: Record<string, unknown>[] }).skills
    // Only stable fields cross the wire: no invocation, no resourceBase.
    assert.deepEqual(skills, [
      {
        name: 'pdf-tools',
        description: 'Read and write PDF files',
        whenToUse: 'When a PDF needs parsing',
        source: 'project-dsh',
        provider: 'filesystem',
        path: '/tmp/project/.dsh/skills/pdf-tools/SKILL.md',
      },
      { name: 'review', description: 'Code review checklist', source: 'user-dsh', provider: 'filesystem' },
    ])
    assert.deepEqual(mocks.calls.skillLookups, [{ cwd: '/tmp/project' }])

    // Without a session id the process cwd drives the project layer.
    await client.request('skill.list')
    assert.deepEqual(mocks.calls.skillLookups[1], { cwd: process.cwd() })

    // A stored session contributes its header cwd as well.
    await client.request('skill.list', { sessionId: 'stored-1' })
    assert.deepEqual(mocks.calls.skillLookups[2], { cwd: '/tmp/stored-project' })

    const unknown = await client.request('skill.list', { sessionId: 'gone' })
    assert.equal((unknown.error as { code: number; data: { code: string } }).data.code, 'session/not-found')
    client.close()
  })
})

test('skill.list returns an empty catalog and degrades without the service', async () => {
  await withCore((deps, mocks) => {
    mocks.skills.list = async () => []
    void deps
  }, async (core) => {
    const client = new TestClient()
    await client.connect(core.port as number)
    const empty = await client.request('skill.list')
    assert.deepEqual(empty.result, { skills: [] })
    client.close()
  })

  await withCore((deps) => {
    ;(deps as unknown as Record<string, unknown>).getSkills = () => undefined
  }, async (core) => {
    const client = new TestClient()
    await client.connect(core.port as number)
    const listed = await client.request('skill.list')
    const error = listed.error as { code: number; data: { code: string; service: string } }
    assert.equal(error.code, -32002)
    assert.equal(error.data.service, 'skills')
    client.close()
  })
})

test('session.exportZip streams the archive to a host file', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bridge-export-'))
  try {
    await withCore((deps, mocks) => {
      mocks.live.set('s1', makeSession('s1', '/tmp/project'))
      mocks.exportLogs.set('s1', '{"type":"session"}\n')
      ;(deps as unknown as Record<string, unknown>).sessionPersistence = { stat: async () => undefined }
    }, async (core, mocks) => {
      const client = new TestClient()
      await client.connect(core.port as number)
      const destPath = join(root, 'out', 'my-export.zip')
      const exported = await client.request('session.exportZip', { sessionId: 's1', destPath })
      const result = exported.result as { path: string; fileName: string; bytes: number; entries: number }
      assert.equal(result.path, destPath)
      assert.equal(result.fileName, 'dsh-session-s1.zip')
      assert.equal(result.entries, 2)
      // The live session was flushed before its log was read, descendants included.
      assert.deepEqual(mocks.calls.exportFlushes, ['s1'])
      assert.deepEqual(mocks.calls.flushes, ['s1'])
      assert.deepEqual(mocks.calls.exportStreams, [{ id: 's1', includeDescendants: true, level: 6 }])
      // The file on disk is the exact archive the stream produced.
      const stats = await stat(destPath)
      assert.equal(result.bytes, stats.size)
      const bytes = await readFile(destPath)
      assert.equal(bytes.subarray(0, 4).toString('hex'), '504b0304')
      assert.ok(bytes.includes(Buffer.from('session.v3.jsonl')))
      client.close()
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('session.exportZip defaults to a tmpdir path named after the session', async () => {
  let produced: string | undefined
  try {
    await withCore((deps, mocks) => {
      mocks.exportLogs.set('cold-1', '{"type":"session"}\n')
      ;(deps as unknown as Record<string, unknown>).sessionPersistence = { stat: async () => undefined }
    }, async (core) => {
      const client = new TestClient()
      await client.connect(core.port as number)
      const exported = await client.request('session.exportZip', { sessionId: 'cold-1' })
      const result = exported.result as { path: string; fileName: string; bytes: number; entries: number }
      produced = result.path
      assert.equal(result.fileName, 'dsh-session-cold-1.zip')
      assert.equal(result.path, join(tmpdir(), 'dsh-session-export', 'dsh-session-cold-1.zip'))
      assert.equal(result.entries, 2)
      assert.ok(existsSync(result.path))
      client.close()
    })
  } finally {
    if (produced !== undefined) await rm(produced, { force: true })
  }
})

test('session.exportZip reports unknown sessions and degraded services', async () => {
  await withCore((deps) => {
    ;(deps as unknown as Record<string, unknown>).sessionPersistence = { stat: async () => undefined }
  }, async (core) => {
    const client = new TestClient()
    await client.connect(core.port as number)
    const missing = await client.request('session.exportZip', { sessionId: 'ghost' })
    const missingError = missing.error as { code: number; data: { code: string } }
    assert.equal(missingError.code, -32004)
    assert.equal(missingError.data.code, 'session/not-found')
    client.close()
  })

  // sessionQuery missing: the whole feature degrades to service-unavailable.
  await withCore((deps) => {
    ;(deps as unknown as Record<string, unknown>).getSessionQuery = () => undefined
  }, async (core) => {
    const client = new TestClient()
    await client.connect(core.port as number)
    const exported = await client.request('session.exportZip', { sessionId: 's1' })
    const error = exported.error as { code: number; data: { code: string; service: string } }
    assert.equal(error.code, -32002)
    assert.equal(error.data.service, 'sessionQuery')
    client.close()
  })
})

test('session.exportZip probes the archive module once and flips the capability on failure', async () => {
  let loads = 0
  await withCore((deps) => {
    const mutable = deps as unknown as Record<string, unknown>
    mutable.sessionPersistence = { stat: async () => undefined }
    mutable.loadSessionLogExport = async () => {
      loads += 1
      return undefined
    }
  }, async (core) => {
    const client = new TestClient()
    await client.connect(core.port as number)

    // Optimistic before the first call: the engine service is present.
    const before = await client.request('bridge.handshake')
    assert.equal((before.result as { capabilities: { sessionExport: boolean } }).capabilities.sessionExport, true)

    const exported = await client.request('session.exportZip', { sessionId: 's1' })
    const error = exported.error as { code: number; data: { code: string; service: string } }
    assert.equal(error.code, -32002)
    assert.equal(error.data.service, 'session-log-export')

    // The probe is cached: later calls and handshakes reuse the failure.
    await client.request('session.exportZip', { sessionId: 's1' })
    assert.equal(loads, 1)
    const after = await client.request('bridge.handshake')
    assert.equal((after.result as { capabilities: { sessionExport: boolean } }).capabilities.sessionExport, false)
    client.close()
  })
})

test('session.exportZip removes the partial file when the stream fails mid-write', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bridge-export-fail-'))
  try {
    await withCore((deps, mocks) => {
      mocks.exportLogs.set('stream-fails', '{"type":"session"}\n')
      ;(deps as unknown as Record<string, unknown>).sessionPersistence = { stat: async () => undefined }
    }, async (core) => {
      const client = new TestClient()
      await client.connect(core.port as number)
      const destPath = join(root, 'broken.zip')
      const exported = await client.request('session.exportZip', { sessionId: 'stream-fails', destPath })
      assert.equal((exported.error as { code: number }).code, -32603)
      assert.equal(existsSync(destPath), false, 'a truncated archive is never left behind')
      client.close()
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('session.exportZip aborts the stream when the connection drops', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bridge-export-abort-'))
  try {
    await withCore((deps, mocks) => {
      mocks.exportLogs.set('never-ends', '{"type":"session"}\n')
      ;(deps as unknown as Record<string, unknown>).sessionPersistence = { stat: async () => undefined }
    }, async (core, mocks) => {
      const client = new TestClient()
      await client.connect(core.port as number)
      const destPath = join(root, 'aborted.zip')
      void client.request('session.exportZip', { sessionId: 'never-ends', destPath })
      await waitFor(() => mocks.calls.exportStreams.length === 1)
      client.close()
      await waitFor(() => !existsSync(destPath))
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

// The real archive module, exercised when the devDependency is resolvable.
const realExportModule = await import('@deepseek-ai/dsh-session-log-export').catch(() => undefined)

test('session.exportZip produces a valid ZIP through the real archive module', { skip: realExportModule === undefined }, async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bridge-export-real-'))
  try {
    const header = (id: string, parentSession?: string) => ({
      version: 3,
      id,
      createdAt: 1_700_000_000_000,
      isSeeded: false,
      cwd: '/tmp/project',
      ...(parentSession === undefined ? {} : { parentSession }),
    })
    const storedLogs = new Map<string, { header: ReturnType<typeof header>; events: unknown[] }>([
      ['root', { header: header('root'), events: [{ type: 'session/title', seq: 1, time: 1, data: { title: 'Root' } }] }],
      ['child', { header: header('child', 'root'), events: [] }],
    ])
    await withCore((deps, mocks) => {
      mocks.live.set('root', makeSession('root', '/tmp/project'))
      const mutable = deps as unknown as Record<string, unknown>
      mutable.sessionPersistence = {
        open: async (id: string) => {
          const log = storedLogs.get(id)
          assert.notEqual(log, undefined, `persistence.open(${id})`)
          return {
            header: log.header,
            read: async () => ({ events: log.events }),
            close: async () => {},
          }
        },
      }
      mutable.getSessionQuery = () => ({
        traceSession: async () => ({
          descendants: [{ session: { header: header('child', 'root') }, descendants: [] }],
        }),
      })
      mutable.loadSessionLogExport = async () => realExportModule
    }, async (core, mocks) => {
      const client = new TestClient()
      await client.connect(core.port as number)
      const destPath = join(root, 'real.zip')
      const exported = await client.request('session.exportZip', { sessionId: 'root', destPath })
      const result = exported.result as { path: string; fileName: string; bytes: number; entries: number }
      assert.equal(result.fileName, 'dsh-session-root.zip')
      // Root log plus the subagent descendant log.
      assert.equal(result.entries, 2)
      assert.deepEqual(mocks.calls.flushes, ['root'])
      const bytes = await readFile(destPath)
      assert.equal(bytes.subarray(0, 4).toString('hex'), '504b0304')
      assert.ok(bytes.includes(Buffer.from('subagents/child/')))
      assert.equal(result.bytes, bytes.byteLength)
      client.close()
    })
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

async function waitFor(condition: () => boolean, attempts = 200): Promise<void> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (condition()) return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  assert.ok(condition(), 'condition not met within the wait budget')
}
