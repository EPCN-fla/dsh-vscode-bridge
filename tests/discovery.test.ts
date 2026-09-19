/** Discovery file tests: publish, replace, teardown cleanup, stale sweep. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DiscoveryFile } from '../src/discovery.ts'
import { BRIDGE_PLUGIN_NAME } from '../src/protocol.ts'

const silent = { info() {}, warn() {}, error() {} }

function payload(port: number, directories: readonly string[] = []) {
  return {
    protocolVersion: 1,
    plugin: BRIDGE_PLUGIN_NAME,
    version: '0.1.0',
    pid: process.pid,
    host: '127.0.0.1',
    port,
    token: 'test-token',
    startedAt: new Date().toISOString(),
    capabilities: {
      workspaceGrouping: true,
      sessionTitle: true,
      sessionArchive: true,
      presets: true,
      permissions: true,
      eventPush: true,
    },
    directories,
  }
}

test('publish writes a single mode-0600 <pid>.json; clear removes it', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bridge-discovery-'))
  const directory = join(root, 'nested') // created on demand
  const discovery = new DiscoveryFile({ directory, logger: silent })
  await discovery.publish(payload(7310, ['/repo/a', '/repo/b']))
  const target = join(directory, `${process.pid}.json`)
  const first = JSON.parse(await readFile(target, 'utf8'))
  assert.equal(first.port, 7310)
  assert.equal(first.token, 'test-token')
  assert.deepEqual(first.directories, ['/repo/a', '/repo/b'])
  const mode = (await stat(target)).mode & 0o777
  assert.equal(mode, 0o600)
  const dirMode = (await stat(directory)).mode & 0o777
  assert.equal(dirMode, 0o700)
  assert.deepEqual(discovery.paths, [target])
  await discovery.clear()
  assert.equal(existsSync(target), false)
  assert.deepEqual(discovery.paths, [])
  await rm(root, { recursive: true, force: true })
})

test('re-publish replaces the file in place', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bridge-discovery-'))
  const discovery = new DiscoveryFile({ directory: root, logger: silent })
  await discovery.publish(payload(7310, ['/repo/a']))
  await discovery.publish(payload(7311, ['/repo/a', '/repo/c']))
  const current = JSON.parse(await readFile(join(root, `${process.pid}.json`), 'utf8'))
  assert.equal(current.port, 7311)
  assert.deepEqual(current.directories, ['/repo/a', '/repo/c'])
  await rm(root, { recursive: true, force: true })
})

test('clearSync removes the published file (process exit path)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bridge-discovery-'))
  const discovery = new DiscoveryFile({ directory: root, logger: silent })
  await discovery.publish(payload(7310))
  discovery.clearSync()
  assert.equal(existsSync(join(root, `${process.pid}.json`)), false)
  await rm(root, { recursive: true, force: true })
})

test('sweepStale reaps dead-pid entries and keeps live ones', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bridge-discovery-'))
  // A process that has already exited: its pid is dead (barring instant reuse).
  const child = spawn(process.execPath, ['-e', ''])
  await new Promise((resolve) => child.once('exit', resolve))
  const deadPid = child.pid as number

  const stale = join(root, `${deadPid}.json`)
  const live = join(root, `${process.pid}.json`)
  const foreign = join(root, 'notes.txt')
  await writeFile(stale, '{"stale":true}\n')
  await writeFile(live, '{"live":true}\n')
  await writeFile(foreign, 'keep me\n')

  const discovery = new DiscoveryFile({ directory: root, logger: silent })
  await discovery.sweepStale()
  assert.equal(existsSync(stale), false)
  assert.equal(existsSync(live), true)
  assert.equal(existsSync(foreign), true)
  await rm(root, { recursive: true, force: true })
})

test('sweepStale on a missing directory is a no-op', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bridge-discovery-'))
  const discovery = new DiscoveryFile({ directory: join(root, 'missing'), logger: silent })
  await discovery.sweepStale()
  await rm(root, { recursive: true, force: true })
})

test('publish into an uncreatable directory rejects (core turns it into a warning)', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-bridge-discovery-'))
  const blocker = join(root, 'blocker')
  await writeFile(blocker, 'not a directory\n')
  const discovery = new DiscoveryFile({ directory: join(blocker, 'sub'), logger: silent })
  await assert.rejects(discovery.publish(payload(7310)))
  await rm(root, { recursive: true, force: true })
})
