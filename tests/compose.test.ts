/**
 * Real-composition smoke test: load the plugin into an actual Cordis context
 * with stand-in services under the real service keys, then drive the wire
 * protocol end to end (discover → connect → handshake → RPC → dispose).
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createConnection } from 'node:net'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
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
  ctx.provide('sessions', { list: () => [], get: () => undefined })
  ctx.provide('sessionPersistence', { list: async () => [], stat: async () => undefined })
  ctx.provide('sessionTitle', { get: () => undefined, rename: () => ({ title: 't', updatedAt: 0 }) })
  ctx.provide('workspaceRegistry', {
    list: () => [],
    archivedSessionIds: [],
    resolveByPath: async () => undefined,
    create: async () => {
      throw new Error('not used')
    },
    archiveSession: async () => {},
  })
  ctx.provide('permissionPresets', {
    names: ['workspace-write'],
    defaultPreset: 'workspace-write',
    optionOf: (name: string) => ({ value: name, name }),
    current: () => 'workspace-write',
    set: () => {},
  })
  ctx.provide('agents', { get: () => undefined })

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
    const result = hello.result as { plugin: string; protocolVersion: number }
    assert.equal(result.plugin, 'dsh-vscode-bridge')
    assert.equal(result.protocolVersion, 1)

    const workspaces = await roundTrip(payload as { port: number; token: string }, 'workspace.list', (payload as { token: string }).token)
    assert.deepEqual(workspaces.result, { workspaces: [], archivedSessionIds: [] })
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
  socket.write(`${JSON.stringify({ jsonrpc: '2.0', id: 1, method, token })}\n`)
  const message = await response
  socket.destroy()
  return message
}
