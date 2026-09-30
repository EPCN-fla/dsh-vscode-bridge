/**
 * Real-composition smoke test: load the plugin into an actual Cordis context
 * with stand-in services under the real service keys, then drive the wire
 * protocol end to end (discover → connect → handshake → RPC → dispose).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createConnection } from 'node:net'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import * as plugin from '../src/index.ts'

test('the function plugin loads, serves, and unloads cleanly in a real Cordis context', async () => {
  const workspace = await mkdtemp(join(tmpdir(), 'dsh-bridge-compose-'))
  const discoveryPath = join(workspace, `${process.pid}.json`)
  const ctx = new Context()

  // Stand-ins under the real service keys declared in `inject`.
  ctx.provide('sessionPersistence', { list: async () => [], stat: async () => undefined })
  ctx.provide('sessionTitle', { get: () => undefined, rename: () => ({ title: 't', updatedAt: 0 }) })
  ctx.provide('workspaceRegistry', {
    list: () => [],
    archivedSessionIds: [],
    resolveByPath: async () => undefined,
    create: async (path: string) => ({
      id: 'ws-1',
      path,
      title: path,
      sessionIds: [] as string[],
      attachSession: async (id: string) => {
        void id
      },
    }),
    archiveSession: async () => {},
  })
  ctx.provide('permissionPresets', {
    names: ['workspace-write'],
    defaultPreset: 'workspace-write',
    optionOf: (name: string) => ({ value: name, name }),
    current: () => 'workspace-write',
    set: () => {},
  })
  ctx.provide('agents', {
    get: (id: string) => (id === 's1' ? { id, ctx: {} } : undefined),
  })
  // A live session with a cwd, for the command channel roundtrip.
  const liveSession = {
    id: 's1',
    header: { version: 3, id: 's1', createdAt: 1, isSeeded: false, cwd: workspace },
  }
  ctx.provide('sessions', { list: () => [liveSession], get: (id: string) => (id === 's1' ? liveSession : undefined) })
  // Stand-ins for the optional v0.1.3 services, under their real keys.
  ctx.provide('commands', {
    list: () => [
      { name: 'compact', description: 'Compact the conversation', input: { hint: 'Optional focus' } },
      { name: 'plan', description: 'Toggle plan mode' },
    ],
    execute: async (agent: { id: string }, line: string) => (line === '/plan'
      ? { commandId: 'cmd-compose', result: { kind: 'success', text: `plan toggled for ${agent.id}` } }
      : undefined),
  })
  ctx.provide('skills', {
    list: async (options?: { cwd?: string }) => {
      void options
      return [
        { name: 'pdf-tools', description: 'Read and write PDF files', source: 'project-dsh', provider: 'filesystem', invocation: { modelInvocable: true, userInvocable: true } },
      ]
    },
  })
  // The launcher-provided profile context (DSH >= 0.1.7): the install anchor
  // points at the owning CLI's manifest, here a stand-in temp install.
  const installAnchor = join(workspace, 'dsh-install', 'package.json')
  await mkdir(join(installAnchor, '..'), { recursive: true })
  await writeFile(installAnchor, `${JSON.stringify({ name: '@deepseek-ai/dsh', version: '0.1.7-rc.1' })}\n`, 'utf8')
  ctx.provide('profileContext', { installAnchor })
  // The 0.1.7-shaped preset registry stand-in: roster entries carry no
  // `trust` (removed upstream with the declarative-preset split).
  ctx.provide('agentPresets', {
    defaultId: 'standard',
    list: async () => [
      { id: 'standard', name: 'Standard' },
      { id: 'minimal', description: 'Minimal toolset' },
    ],
    composedPreset: () => 'standard',
    select: async (_agent: unknown, presetId: string) => presetId,
  })

  const fiber = await ctx.plugin(plugin, {
    portStart: 47510,
    portEnd: 47519,
    discoveryDir: workspace,
  })
  try {
    // The listener starts asynchronously inside the plugin effect; wait for
    // the discovery file it publishes into the configured discovery dir.
    let payload: { port: number; token: string; directories: string[] } | undefined
    for (let attempt = 0; attempt < 100; attempt += 1) {
      if (existsSync(discoveryPath)) {
        payload = JSON.parse(await readFile(discoveryPath, 'utf8'))
        break
      }
      await new Promise((resolve) => setTimeout(resolve, 50))
    }
    assert.notEqual(payload, undefined, 'discovery file was published')
    assert.ok(payload?.directories.includes(process.cwd()), 'discovery payload lists the process cwd')

    // Wrong token is rejected; the right token gets the handshake.
    const wrong = await roundTrip(payload as { port: number; token: string }, 'bridge.handshake', 'nope')
    assert.equal((wrong.error as { code: number }).code, -32001)
    const hello = await roundTrip(payload as { port: number; token: string }, 'bridge.handshake', (payload as { token: string }).token)
    const result = hello.result as { plugin: string; protocolVersion: number; dshVersion?: string }
    assert.equal(result.plugin, 'dsh-vscode-bridge')
    assert.equal(result.protocolVersion, 1)
    // Host-version reporting rides the same composition end to end: the
    // launcher-provided profileContext anchor is read through ctx.get.
    assert.equal(result.dshVersion, '0.1.7-rc.1')
    assert.equal((payload as { dshVersion?: string }).dshVersion, '0.1.7-rc.1')

    const workspaces = await roundTrip(payload as { port: number; token: string }, 'workspace.list', (payload as { token: string }).token)
    assert.deepEqual(workspaces.result, { workspaces: [], archivedSessionIds: [] })

    // The v0.1.3 channels ride the same composition: capability flags on, then
    // native command catalog/execution and the skill catalog roundtrip.
    const capabilities = (hello.result as { capabilities: Record<string, boolean> }).capabilities
    assert.equal(capabilities.commands, true)
    assert.equal(capabilities.skills, true)
    assert.equal(capabilities.presets, true)
    assert.equal(capabilities.permissions, true)

    const listed = await roundTrip(payload as { port: number; token: string }, 'command.list', (payload as { token: string }).token, { sessionId: 's1' })
    assert.deepEqual(listed.result, {
      commands: [
        { name: 'compact', description: 'Compact the conversation', inputHint: 'Optional focus' },
        { name: 'plan', description: 'Toggle plan mode' },
      ],
    })

    const ran = await roundTrip(payload as { port: number; token: string }, 'command.run', (payload as { token: string }).token, { sessionId: 's1', line: '/plan' })
    assert.deepEqual(ran.result, { commandId: 'cmd-compose', kind: 'success', text: 'plan toggled for s1' })

    const unknown = await roundTrip(payload as { port: number; token: string }, 'command.run', (payload as { token: string }).token, { sessionId: 's1', line: '/nope' })
    assert.equal((unknown.error as { data: { code: string } }).data.code, 'command/unknown')

    const skills = await roundTrip(payload as { port: number; token: string }, 'skill.list', (payload as { token: string }).token, { sessionId: 's1' })
    assert.deepEqual(skills.result, {
      skills: [
        { name: 'pdf-tools', description: 'Read and write PDF files', source: 'project-dsh', provider: 'filesystem' },
      ],
    })

    // The 0.1.7 preset channel: the trust-less roster roundtrips with the
    // field omitted (never serialized as `undefined`).
    const presets = await roundTrip(payload as { port: number; token: string }, 'preset.list', (payload as { token: string }).token)
    assert.deepEqual(presets.result, {
      default: 'standard',
      presets: [
        { id: 'standard', isDefault: true, name: 'Standard' },
        { id: 'minimal', isDefault: false, description: 'Minimal toolset' },
      ],
    })

    const permission = await roundTrip(payload as { port: number; token: string }, 'permission.get', (payload as { token: string }).token, { sessionId: 's1' })
    assert.deepEqual(permission.result, {
      options: [{ value: 'workspace-write', name: 'workspace-write' }],
      default: 'workspace-write',
      current: 'workspace-write',
    })

    const sessions = await roundTrip(payload as { port: number; token: string }, 'session.list', (payload as { token: string }).token)
    assert.deepEqual(sessions.result, {
      sessions: [{
        sessionId: 's1',
        live: true,
        cwd: workspace,
        createdAt: 1,
        parentSession: null,
        title: null,
        permission: 'workspace-write',
        agentPreset: 'standard',
      }],
      storedIncluded: false,
    })
  } finally {
    await fiber.dispose()
  }
  assert.equal(existsSync(discoveryPath), false, 'discovery file removed on unload')
  assert.equal(existsSync(join(process.cwd(), '.dsh-bridge.json')), false, 'nothing written into the workspace')
  await rm(workspace, { recursive: true, force: true })
})

async function roundTrip(
  discovery: { port: number },
  method: string,
  token: string,
  params?: unknown,
): Promise<Record<string, unknown>> {
  const socket = createConnection({ host: '127.0.0.1', port: discovery.port })
  await new Promise<void>((resolve) => socket.once('connect', resolve))
  const response = new Promise<Record<string, unknown>>((resolve) => {
    let buffer = ''
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8')
      const newline = buffer.indexOf('\n')
      if (newline >= 0) resolve(JSON.parse(buffer.slice(0, newline)))
    })
  })
  socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method, token, ...(params === undefined ? {} : { params }) })}\n`)
  const message = await response
  socket.destroy()
  return message
}
