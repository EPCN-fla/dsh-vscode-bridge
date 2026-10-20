/** Credential-free packaged-entry proof. Usage: node scripts/runtime-smoke.mjs <runtime-dir> <tarball> */
import { mkdir, mkdtemp, writeFile, readFile, readdir } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { createConnection } from 'node:net'
import { createRequire } from 'node:module'
import assert from 'node:assert/strict'

const pluginVersion = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8')).version
const runtime = resolve(process.argv[2] ?? '.sandbox/runtime-rc2')
const artifact = resolve(process.argv[3] ?? `.sandbox/artifacts/dsh-vscode-bridge-${pluginVersion}.tgz`)
const require = createRequire(join(runtime, 'package.json'))
const cliManifest = require.resolve('@deepseek-ai/dsh/package.json')
const cliMetadata = JSON.parse(await readFile(cliManifest, 'utf8'))
const cliVersion = cliMetadata.version
const requestedVersion = JSON.parse(await readFile(join(runtime, 'package.json'), 'utf8')).dependencies['@deepseek-ai/dsh']
assert.equal(cliVersion, requestedVersion, 'runtime must pin one exact DSH version')
const cli = resolve(dirname(cliManifest), cliMetadata.bin.dsh)
await mkdir('.sandbox', { recursive: true })
const home = await mkdtemp(resolve('.sandbox', 'smoke-home-'))
const profile = join(home, 'profiles', 'bridge-test')
const web = join(home, 'profiles', 'web')
const discovery = join(home, 'discovery')
for (const path of [profile, web, discovery]) await mkdir(path, { recursive: true })
await writeFile(join(profile, 'package.json'), JSON.stringify({ private: true,
  dependencies: { 'dsh-vscode-bridge': `file:${artifact}` },
  dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-acp-app'] } },
}))
await writeFile(join(profile, 'pnpm-workspace.yaml'), 'nodeLinker: hoisted\nautoInstallPeers: false\n')
const install = spawnSync('pnpm', ['install', '--ignore-scripts', '--store-dir', resolve('.sandbox/pnpm-store'), '--registry=https://registry.npmjs.org'], { cwd: profile, encoding: 'utf8', timeout: 120000 })
assert.equal(install.status, 0, install.stderr)
await writeFile(join(web, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'] } } }))
const sourcePatch = `- id: llm-pi-ai
  config:
    providers:
      bridge-test-model:
        api: openai-completions
        baseURL: http://127.0.0.1:1/v1
        apiKey: test-only
        models: [{id: bridge-model, contextWindow: 8192, maxTokens: 512}]
- insert:
    - id: preset-bridge-test
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: bridge-test
        plugins: []
`
await writeFile(join(web, 'cordis.patch.yml'), sourcePatch)
await writeFile(join(profile, 'cordis.patch.yml'), `- id: session-log-deepseek
  disabled: true
- id: session-telemetry-otel
  disabled: true
- id: plugin-package-inventory-deepseek
  disabled: true
- insert:
    - id: workspace
      name: '@deepseek-ai/dsh-workspace'
    - id: bridge
      name: dsh-vscode-bridge
      config:
        discoveryDir: ${JSON.stringify(discovery)}
        portStart: 48710
        portEnd: 48729
`)

async function start() {
  const child = spawn(process.execPath, [cli, '--profile', 'bridge-test'], { cwd: runtime,
    env: { PATH: process.env.PATH, HOME: home, DSH_HOME: home, DSH_TELEMETRY_DISABLED: '1' }, stdio: ['pipe', 'pipe', 'pipe'],
  })
  let stderr = '', stdout = '', id = 0
  const pending = new Map()
  child.stderr.on('data', buffer => { stderr += buffer })
  child.stdout.on('data', buffer => {
    stdout += buffer
    while (stdout.includes('\n')) {
      const offset = stdout.indexOf('\n'), line = stdout.slice(0, offset)
      stdout = stdout.slice(offset + 1)
      if (!line.trim()) continue
      const message = JSON.parse(line)
      const request = pending.get(message.id)
      if (request) { pending.delete(message.id); message.error ? request.reject(new Error(JSON.stringify(message.error))) : request.resolve(message.result) }
    }
  })
  const exit = new Promise((resolveExit, reject) => { child.once('exit', (code, signal) => resolveExit({ code, signal })); child.once('error', reject) })
  async function acp(method, params) {
    const requestId = ++id
    let timer
    try {
      return await new Promise((resolveRequest, reject) => {
        pending.set(requestId, { resolve: resolveRequest, reject })
        timer = setTimeout(() => reject(new Error(`ACP timeout: ${method}`)), 15000)
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: requestId, method, params })}\n`)
      })
    } finally { clearTimeout(timer); pending.delete(requestId) }
  }
  async function stop() {
    child.stdin.end()
    let timer
    const result = await Promise.race([exit, new Promise(resolveTimeout => { timer = setTimeout(() => resolveTimeout(null), 5000) })])
    clearTimeout(timer)
    if (!result) { child.kill('SIGTERM'); await exit }
    await writeFile(join(home, `startup-${child.pid}.log`), stderr)
    assert.ok(result, 'host failed graceful EOF shutdown')
    assert.equal(result.code, 0, stderr)
    assert.equal((await readdir(discovery)).includes(`${child.pid}.json`), false)
  }
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      const info = JSON.parse(await readFile(join(discovery, `${child.pid}.json`), 'utf8'))
      return { info, acp, stop }
    } catch (error) { if (error.code !== 'ENOENT') throw error }
    if (child.exitCode !== null) break
    await new Promise(resolveWait => setTimeout(resolveWait, 100))
  }
  child.kill('SIGTERM'); await exit
  throw new Error(`Host did not publish discovery: ${stderr.slice(-10000)}`)
}

async function rpc(info, method, params, token = info.token) {
  const socket = createConnection({ host: '127.0.0.1', port: info.port })
  try {
    return await new Promise((resolveRequest, reject) => {
      let data = ''
      socket.setTimeout(15000, () => reject(new Error(`RPC timeout: ${method}`)))
      socket.on('error', reject)
      socket.on('connect', () => socket.write(`${JSON.stringify({ id: 1, method, params, token })}\n`))
      socket.on('data', buffer => {
        data += buffer
        if (!data.includes('\n')) return
        const message = JSON.parse(data.split('\n')[0])
        message.error ? reject(Object.assign(new Error(message.error.message), message.error)) : resolveRequest(message.result)
      })
    })
  } finally { socket.destroy() }
}

const output = { dshVersion: cliVersion, steps: [] }
const snapshot = {}
const run = await start()
try {
  const hello = await rpc(run.info, 'bridge.handshake')
  assert.equal(hello.dshVersion, cliVersion)
  assert.equal(hello.version, pluginVersion)
  await assert.rejects(rpc(run.info, 'config.import', {}, 'wrong'), { code: -32001 })
  const preview = await rpc(run.info, 'config.preview', {})
  assert.ok(preview.providers.includes('bridge-test-model'))
  assert.ok(preview.presets.includes('bridge-test'))
  assert.equal(JSON.stringify(preview).includes('test-only'), false)
  const imported = await rpc(run.info, 'config.import', { revision: preview.revision })
  assert.ok(imported.backupPath)
  Object.assign(snapshot, { source: imported.source, target: imported.target,
    providerImported: imported.providers.includes('bridge-test-model'),
    presetImported: imported.presets.includes('bridge-test'), changed: imported.changed,
    restartRequired: imported.restartRequired, backupCreated: typeof imported.backupPath === 'string',
  })
  assert.equal(await readFile(join(web, 'cordis.patch.yml'), 'utf8'), sourcePatch)
  output.steps.push('packaged handshake', 'authentication', 'preview', 'import', 'source unchanged')
} finally { await run.stop() }
const restarted = await start()
try {
  const presets = await rpc(restarted.info, 'preset.list')
  assert.ok(presets.presets.some(preset => preset.id === 'bridge-test' && !preset.broken))
  assert.deepEqual(presets.presets.filter(preset => preset.broken), [], 'every imported preset must activate')
  snapshot.idempotentAfterRestart = !(await rpc(restarted.info, 'config.preview')).changed
  snapshot.presetActivated = presets.presets.some(preset => preset.id === 'bridge-test' && !preset.broken)
  assert.equal(snapshot.idempotentAfterRestart, true)
  await restarted.acp('initialize', { protocolVersion: 1, clientCapabilities: {}, clientInfo: { name: 'bridge-smoke', version: '1' } })
  const session = await restarted.acp('session/new', { cwd: home, mcpServers: [] })
  snapshot.acpModelVisible = JSON.stringify(session.configOptions).includes('bridge-model')
  assert.ok(snapshot.acpModelVisible, 'imported model appears in real ACP model options')
  await rpc(restarted.info, 'preset.select', { sessionId: session.sessionId, presetId: 'bridge-test' })
  snapshot.selectedPreset = (await rpc(restarted.info, 'preset.current', { sessionId: session.sessionId })).preset
  assert.equal(snapshot.selectedPreset, 'bridge-test')
  output.steps.push('restart', 'all preset activation', 'idempotent preview', 'ACP model catalog', 'live preset selection')
} finally { await restarted.stop() }
output.steps.push('graceful EOF shutdown', 'discovery cleanup')
const expected = JSON.parse(await readFile(new URL('../tests/fixtures/config-import.expected.json', import.meta.url), 'utf8'))
assert.deepEqual(snapshot, expected)
output.snapshot = snapshot
await writeFile(join(home, 'result.json'), `${JSON.stringify(output, null, 2)}\n`)
console.log(JSON.stringify({ ...output, evidence: join(home, 'result.json') }, null, 2))
