import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, readFile, rm, stat, symlink, unlink, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ConfigSync, createConfigSync, loadConfigSyncHost, type ConfigSyncContext } from '../src/config-sync.ts'

async function fixture(t: { after(fn: () => Promise<void>): void }) {
  const home = await mkdtemp(join(tmpdir(), 'bridge-config-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  const source = join(home, 'profiles', 'web')
  const target = join(home, 'profiles', 'acp-test')
  for (const dir of [source, target]) {
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'package.json'), JSON.stringify({ dsh: { profile: { bundles: [] } } }))
  }
  const context: ConfigSyncContext = { name: 'acp-test', home, dir: target,
    patchPath: join(target, 'cordis.patch.yml'), installAnchor: fileURLToPath(new URL('../package.json', import.meta.url)) }
  const sourcePatch = join(source, 'cordis.patch.yml')
  const original = '# target comment\n- insert:\n    - id: unrelated\n      name: cordis:group\n      group: true\n      config: []\n'
  await writeFile(context.patchPath, original)
  await writeFile(sourcePatch, `- insert:
    - id: llm-pi-ai
      name: '@deepseek-ai/dsh-llm-pi-ai'
      config:
        providers:
          example:
            api: openai-completions
            apiKey: test-secret-never-on-wire
            baseURL: https://example.invalid/v1
            models: [{ id: test-model }]
          env-route:
            apiKey: !!js process.env.EXAMPLE_KEY
            models: [{ id: env-model }]
    - id: preset-custom
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: custom
        plugins:
          - id: nested
            name: cordis:group
            group: true
            disabled: !!js process.platform === 'win32'
            config: []
`)
  const native = await loadConfigSyncHost(context)
  // Package availability is the only mocked boundary: native parsing, patch
  // composition, expression serialization and every filesystem operation run.
  const host = { ...native, bundleDir: (_name: string, _dir: string) => target }
  return { home, sourcePatch, context, original, host, sync: new ConfigSync(context, host) }
}

test('native YAML import preserves expressions, unrelated rows and exact rollback bytes', async t => {
  const f = await fixture(t)
  const sourceBefore = await readFile(f.sourcePatch, 'utf8')
  const preview = await f.sync.preview({})
  assert.deepEqual({ ...preview, revision: '<revision>' }, {
    source: 'web', target: 'acp-test', revision: '<revision>',
    providers: ['example', 'env-route'], presets: ['custom'], skipped: [], supportRows: [], changed: true, restartRequired: true,
  })
  assert.equal(JSON.stringify(preview).includes('test-secret'), false)
  assert.equal(await readFile(f.context.patchPath, 'utf8'), f.original)
  const result = await f.sync.import({ revision: preview.revision })
  assert.equal(await readFile(result.backupPath!, 'utf8'), f.original)
  assert.equal((await stat(result.backupPath!)).mode & 0o777, 0o600)
  assert.equal((await stat(f.context.patchPath)).mode & 0o777, 0o600)
  assert.equal(await readFile(f.sourcePatch, 'utf8'), sourceBefore)
  const rows = f.host.compose([f.host.parse(f.context.patchPath)])
  assert.equal(rows[0]?.id, 'unrelated')
  assert.match(await readFile(f.context.patchPath, 'utf8'), /!!js process.env.EXAMPLE_KEY/)
  assert.match(await readFile(f.context.patchPath, 'utf8'), /!!js process.platform/)
  const again = await f.sync.preview({})
  assert.equal(again.changed, false)
  assert.equal((await f.sync.import({ revision: again.revision })).backupPath, undefined)
})

test('model-only import keeps existing routes unless overwrite is explicit', async t => {
  const f = await fixture(t)
  await writeFile(f.context.patchPath, `- insert:
    - id: llm-pi-ai
      name: '@deepseek-ai/dsh-llm-pi-ai'
      config:
        ownField: retained
        providers:
          example: { apiKey: target-key, models: [{ id: original }] }
          target-only: { models: [{ id: retained }] }
`)
  const preview = await f.sync.preview({ presets: false })
  assert.deepEqual(preview.providers, ['env-route'])
  assert.deepEqual(preview.skipped, ['provider:example'])
  await f.sync.import({ presets: false, revision: preview.revision })
  let output = await readFile(f.context.patchPath, 'utf8')
  assert.match(output, /target-key/)
  assert.match(output, /target-only/)
  assert.doesNotMatch(output, /preset-custom/)
  const replace = await f.sync.preview({ presets: false, overwrite: true })
  await f.sync.import({ presets: false, overwrite: true, revision: replace.revision })
  const effective = f.host.compose([f.host.parse(f.context.patchPath)])
  output = JSON.stringify(effective)
  assert.match(output, /test-secret-never-on-wire/)
  assert.doesNotMatch(output, /target-key/)
  assert.match(output, /ownField/)
  assert.match(output, /target-only/)
})

test('stale source, target and option generations refuse writes', async t => {
  const f = await fixture(t)
  const preview = await f.sync.preview({})
  await assert.rejects(f.sync.import({ revision: preview.revision, models: false }), /preview again/)
  await writeFile(f.sourcePatch, `${await readFile(f.sourcePatch, 'utf8')}\n# edited\n`)
  await assert.rejects(f.sync.import({ revision: preview.revision }), /preview again/)
  const next = await f.sync.preview({})
  await writeFile(f.context.patchPath, `${f.original}\n# user edit\n`)
  await assert.rejects(f.sync.import({ revision: next.revision }), /preview again/)
  assert.equal(await readFile(f.context.patchPath, 'utf8'), `${f.original}\n# user edit\n`)
})

test('concurrent imports serialize and reject the stale second write', async t => {
  const f = await fixture(t)
  const preview = await f.sync.preview({})
  const results = await Promise.allSettled([
    f.sync.import({ revision: preview.revision }), f.sync.import({ revision: preview.revision }),
  ])
  assert.deepEqual(results.map(result => result.status), ['fulfilled', 'rejected'])
})

test('missing target packages and row collisions fail before writing', async t => {
  const f = await fixture(t)
  const unavailable = new ConfigSync(f.context, { ...f.host, bundleDir() { throw new Error('missing') } })
  await assert.rejects(unavailable.preview({}), /Install @deepseek-ai\/dsh-llm-pi-ai/)
  await writeFile(f.context.patchPath, '- insert:\n    - id: llm-pi-ai\n      name: wrong-package\n')
  await assert.rejects(f.sync.preview({}), /belongs to another plugin/)
})

test('invalid options and self imports are rejected', async t => {
  const f = await fixture(t)
  await assert.rejects(f.sync.preview({ source: '../other' }), /Unknown import option/)
  await assert.rejects(f.sync.preview({ models: 'yes' }), /must be boolean/)
  await assert.rejects(f.sync.preview({ models: false, presets: false }), /Select/)
  assert.throws(() => f.sync.import({}), /revision/)
  const self = new ConfigSync({ ...f.context, dir: join(f.home, 'profiles', 'web') }, f.host)
  await assert.rejects(self.preview({}), /already the active profile/)
})

test('preset support rows are previewed and imported without enabling Web UI', async t => {
  const f = await fixture(t)
  await writeFile(f.sourcePatch, `- insert:
    - id: preset-cordis
      name: '@deepseek-ai/dsh-agent-preset'
      config:
        id: cordis
        plugins:
          - id: tool-cordis
            name: '@deepseek-ai/dsh-tool-cordis'
    - id: registry
      name: '@deepseek-ai/dsh-agent-preset-registry'
      config: { default: cordis }
    - id: runner
      name: '@deepseek-ai/dsh-cordis-host-runner'
    - id: inspect
      name: '@deepseek-ai/dsh-tool-cordis/host'
    - id: webserver
      name: '@deepseek-ai/dsh-host-webserver'
`)
  const preview = await f.sync.preview({ models: false })
  assert.deepEqual(preview.supportRows, ['registry', 'runner', 'inspect'])
  await f.sync.import({ models: false, revision: preview.revision })
  const rows = f.host.compose([f.host.parse(f.context.patchPath)])
  assert.deepEqual(rows.map(row => row.id), ['unrelated', 'preset-cordis', 'registry', 'runner', 'inspect'])
})

test('import lock and patch links refuse writes and preserve source bytes', async t => {
  const f = await fixture(t)
  const preview = await f.sync.preview({})
  const lockPath = `${f.context.patchPath}.bridge-lock`
  await writeFile(lockPath, '')
  await assert.rejects(f.sync.import({ revision: preview.revision }), /owns the target patch lock/)
  await unlink(lockPath)
  await unlink(f.context.patchPath)
  await symlink(f.sourcePatch, f.context.patchPath)
  const source = await readFile(f.sourcePatch, 'utf8')
  await assert.rejects(f.sync.import({ revision: preview.revision }), /regular files/)
  assert.equal(await readFile(f.sourcePatch, 'utf8'), source)
  assert.equal((await readdir(f.context.dir)).includes('cordis.patch.yml.bridge-lock'), false)
})

test('duplicate declarations, nested model rows and dynamic provider maps fail closed', async t => {
  const f = await fixture(t)
  await writeFile(f.sourcePatch, '- insert:\n    - { id: repeated, name: one }\n    - { id: repeated, name: two }\n')
  await assert.rejects(f.sync.preview({}), /duplicate row ids/)
  await writeFile(f.sourcePatch, `- insert:
    - id: isolated
      name: cordis:group
      group: true
      config:
        - id: llm-pi-ai
          name: '@deepseek-ai/dsh-llm-pi-ai'
          config: { providers: {} }
`)
  await assert.rejects(f.sync.preview({}), /top-level/)
  await writeFile(f.sourcePatch, `- insert:
    - id: llm-pi-ai
      name: '@deepseek-ai/dsh-llm-pi-ai'
      config:
        providers: !!js process.env.PROVIDERS
`)
  await assert.rejects(f.sync.preview({}), /literal mappings/)
  assert.equal(await readFile(f.context.patchPath, 'utf8'), f.original)
})

test('optional service degrades without profile facts and redacts parser failures', async t => {
  const missing = createConfigSync(() => undefined)
  assert.equal(missing.available(), false)
  await assert.rejects(missing.run('preview', {}), /requires a launcher profile/)
  const f = await fixture(t)
  await writeFile(f.sourcePatch, '[apiKey: super-secret: invalid yaml')
  const service = createConfigSync(() => f.context)
  assert.equal(service.available(), true)
  await assert.rejects(service.run('preview', {}), error => {
    assert.doesNotMatch(String(error), /super-secret/)
    assert.match(String(error), /Cannot read or write/)
    return true
  })
})
