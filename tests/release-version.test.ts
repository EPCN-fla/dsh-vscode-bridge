/** Test the real release gate entry under native Node, without npm/network calls. */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('../scripts/check-release-version.mjs', import.meta.url))
function check(...versions: string[]) {
  return spawnSync(process.execPath, [script, ...versions], { encoding: 'utf8', timeout: 10000 })
}

test('release gate accepts 0.4.0 over 0.3.0 and compares numeric version parts', () => {
  for (const [version, latest] of [['0.4.0', '0.3.0'], ['0.10.0', '0.9.0'], ['1.0.0', '1.0.0-rc.2']]) {
    const result = check(version!, latest!)
    assert.equal(result.status, 0, result.stderr)
    assert.equal(result.stderr, '')
    assert.match(result.stdout, /release gate:/)
  }
})

test('release gate rejects equal versions, downgrades and build-only changes', () => {
  for (const [version, latest] of [['0.3.0', '0.3.0'], ['0.2.0', '0.3.0'], ['1.0.0+build.2', '1.0.0+build.1']]) {
    const result = check(version!, latest!)
    assert.equal(result.status, 1)
    assert.match(result.stderr, /is not higher/)
    assert.equal(result.stdout, '')
  }
})

test('release gate fails closed on missing, malformed or multiline versions', () => {
  for (const args of [[], ['0.4.0'], ['0.4.0', ''], ['0.4.0', 'network error'],
    ['not-a-version', '0.3.0'], ['0.4.0', '0.3.0\n0.4.0'], ['0.4.0', '0.3.0', 'extra']]) {
    const result = check(...args)
    assert.equal(result.status, 2)
    assert.doesNotMatch(result.stderr, /is not higher/)
  }
})

test('missing semver is a tool failure, never a false downgrade', async t => {
  const root = await mkdtemp(join(tmpdir(), 'bridge-release-gate-'))
  t.after(() => rm(root, { recursive: true, force: true }))
  const hook = join(root, 'missing-semver.mjs')
  await writeFile(hook, `import { registerHooks } from 'node:module';
registerHooks({ resolve(specifier, context, next) {
  if (specifier === 'semver') throw new Error('simulated missing dependency');
  return next(specifier, context);
} });
`)
  const result = spawnSync(process.execPath, ['--import', hook, script, '0.4.0', '0.3.0'], { encoding: 'utf8', timeout: 10000 })
  assert.equal(result.status, 3, result.stderr)
  assert.match(result.stderr, /semver dependency unavailable/)
  assert.doesNotMatch(result.stderr, /is not higher/)
})

test('CI calls the tested script and keeps execution failures separate', async () => {
  const workflow = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
  assert.match(workflow, /node scripts\/check-release-version\.mjs "\$PKG_VERSION" "\$LATEST"/)
  assert.doesNotMatch(workflow, /npx --yes semver/)
  assert.match(workflow, /STATUS=\$\?[\s\S]*"\$STATUS" -eq 1/)
})
