import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const script = fileURLToPath(new URL('../scripts/ci-compatibility.mjs', import.meta.url))
const fixture = () => ({ name: 'fixture', version: '0.4.0', custom: { untouched: true },
  dshCompatibility: { '9.8.7-rc.1': { cordis: '~4.0.5' }, '10.0.0': { cordis: '~5.1.0' } },
  devDependencies: { '@deepseek-ai/dsh-agent': '9.8.7-rc.1', '@deepseek-ai/dsh-session': '9.8.7-rc.1', '@deepseek-ai/cordis': '~4.0.5', typescript: '6.0.3' },
})
function run(root: string, args: string[], output = join(root, 'output')) {
  return spawnSync(process.execPath, [script, ...args], { cwd: root, env: { ...process.env, GITHUB_OUTPUT: output }, encoding: 'utf8', timeout: 10000 })
}

test('matrix comes from manifest alone and supports new versions without script edits', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-matrix-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const manifest = fixture()
  const path = join(root, 'package.json')
  const original = JSON.stringify(manifest)
  await writeFile(path, original)
  const result = run(root, ['matrix'])
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout), { 'dsh-version': Object.keys(manifest.dshCompatibility) })
  assert.equal(await readFile(path, 'utf8'), original)
  assert.match(await readFile(join(root, 'output'), 'utf8'), /^matrix=\{"dsh-version":/)
})

test('cohort selection uses declared Cordis and preserves unrelated manifest fields', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-cohort-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const manifest = fixture()
  const path = join(root, 'package.json')
  await writeFile(path, JSON.stringify(manifest))
  const unchanged = run(root, ['select', '9.8.7-rc.1'])
  assert.equal(unchanged.status, 0, unchanged.stderr)
  assert.equal(unchanged.stdout.trim(), 'changed=false')
  assert.equal(await readFile(path, 'utf8'), JSON.stringify(manifest))
  const selected = run(root, ['select', '10.0.0'])
  assert.equal(selected.status, 0, selected.stderr)
  assert.equal(selected.stdout.trim(), 'changed=true')
  const after = JSON.parse(await readFile(path, 'utf8'))
  assert.deepEqual(after, { ...manifest, devDependencies: { ...manifest.devDependencies,
    '@deepseek-ai/dsh-agent': '10.0.0', '@deepseek-ai/dsh-session': '10.0.0', '@deepseek-ai/cordis': '~5.1.0' } })
  assert.notEqual(run(root, ['select', 'latest']).status, 0)
})

test('missing, empty and invalid declarations fail rather than silently skipping verification', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-matrix-invalid-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  for (const declaration of [undefined, {}, [], { latest: { cordis: '~4.0.5' } },
    { '^0.2.1': { cordis: '~4.0.5' } }, { '0.2.1-rc.01': { cordis: '~4.0.5' } },
    { '0.2.1': {} }, { '0.2.1': { cordis: 'bad\noutput=value' } }]) {
    await writeFile(join(root, 'package.json'), JSON.stringify({ dshCompatibility: declaration }))
    assert.notEqual(run(root, ['matrix']).status, 0)
  }
})

test('repository manifest produces its current matrix without installing dependencies', async () => {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const manifest = JSON.parse(await readFile(join(root, 'package.json'), 'utf8'))
  const result = spawnSync(process.execPath, [script, 'matrix'], { cwd: root, env: { ...process.env, GITHUB_OUTPUT: '' }, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  assert.deepEqual(JSON.parse(result.stdout)['dsh-version'], Object.keys(manifest.dshCompatibility))
})
