/**
 * detectDshVersion tests: anchor direct-read, anchor-relative resolution
 * (CLI then cohort witness), the argv fallback, and honest absence — all
 * against throwaway install trees. Bare-specifier resolution is jailed to
 * the temp tree it started from, so an ancestor `node_modules` elsewhere on
 * the machine can never leak in and flake a run.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync } from 'node:fs'
import { mkdir, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { join, sep } from 'node:path'
import { pathToFileURL } from 'node:url'
import { detectDshVersion, type DetectDshVersionOptions } from '../src/host-version.ts'

const silent = { info() {}, warn() {}, error() {} }

/**
 * A resolver factory that fails any resolution escaping `jail` — the test's
 * throwaway tree. Real resolution walks ancestors into shared scratch dirs
 * (a transient `/tmp/node_modules` once flipped a run mid-suite); the jail
 * keeps every lookup hermetic.
 */
function jailedRequireFrom(jail: string): (base: string | URL) => NodeRequire {
  const root = jail.endsWith(sep) ? jail : `${jail}${sep}`
  return (base) => {
    const require = createRequire(typeof base === 'string' && base.startsWith('file://') ? new URL(base) : base)
    const resolve = (specifier: string): string => {
      const resolved = require.resolve(specifier)
      if (!`${resolved}${sep}`.startsWith(root)) {
        const error = new Error(`jail: ${specifier} resolved outside the test tree`) as Error & { code: string }
        error.code = 'MODULE_NOT_FOUND'
        throw error
      }
      return resolved
    }
    return Object.assign((id: string) => require(id), {
      resolve: Object.assign(resolve, { paths: require.resolve.paths?.bind(require.resolve) }),
      cache: require.cache,
      extensions: require.extensions,
      main: require.main,
    }) as NodeRequire
  }
}

/** Options scoped to one temp tree: bogus fallbacks plus the jailed resolver. */
function jailed(root: string, overrides: Partial<DetectDshVersionOptions> = {}): DetectDshVersionOptions {
  return {
    argvPath: join(root, 'no-such-cli', 'bin.js'),
    moduleUrl: pathToFileURL(join(root, 'no-such-module', 'noop.js')),
    requireFrom: jailedRequireFrom(root),
    logger: silent,
    ...overrides,
  }
}

async function writeManifest(path: string, name: string, version: string): Promise<void> {
  await mkdir(join(path, '..'), { recursive: true })
  await writeFile(path, `${JSON.stringify({ name, version }, null, 2)}\n`, 'utf8')
}

async function writeFakeCli(tree: string, version: string): Promise<string> {
  const entry = join(tree, 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  await mkdir(join(entry, '..'), { recursive: true })
  await writeFile(entry, '// fake dsh bin\n', 'utf8')
  await writeManifest(join(tree, 'lib', 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), '@deepseek-ai/dsh', version)
  return entry
}

function withTempTree(fn: (root: string) => Promise<void>): () => Promise<void> {
  return async () => {
    const root = mkdtempSync(join(tmpdir(), 'dsh-bridge-version-'))
    try {
      await fn(root)
    } finally {
      await rm(root, { recursive: true, force: true })
    }
  }
}

test('anchor manifest of @deepseek-ai/dsh itself yields its version directly', withTempTree(async (root) => {
  const anchor = join(root, 'dsh', 'package.json')
  await writeManifest(anchor, '@deepseek-ai/dsh', '9.9.9-anchor')
  const version = await detectDshVersion(jailed(root, { profileContext: { installAnchor: anchor } }))
  assert.equal(version, '9.9.9-anchor')
}))

test("packaged-app anchor resolves the CLI manifest from the anchor's install tree", withTempTree(async (root) => {
  const anchor = join(root, 'app', 'package.json')
  await writeManifest(anchor, 'some-desktop-app', '3.0.0')
  await writeManifest(join(root, 'node_modules', '@deepseek-ai', 'dsh', 'package.json'), '@deepseek-ai/dsh', '9.9.8-cli')
  const version = await detectDshVersion(jailed(root, { profileContext: { installAnchor: anchor } }))
  // The CLI version wins over the app manifest's own version.
  assert.equal(version, '9.9.8-cli')
}))

test('cohort package witnesses the version when the CLI itself is not resolvable', withTempTree(async (root) => {
  const anchor = join(root, 'app', 'package.json')
  await writeManifest(anchor, 'some-desktop-app', '3.0.0')
  await writeManifest(join(root, 'node_modules', '@deepseek-ai', 'dsh-agent', 'package.json'), '@deepseek-ai/dsh-agent', '9.9.7-cohort')
  const version = await detectDshVersion(jailed(root, { profileContext: { installAnchor: anchor } }))
  assert.equal(version, '9.9.7-cohort')
}))

test('the CLI entry path covers hosts that provide no profileContext (0.1.5)', withTempTree(async (root) => {
  const entry = await writeFakeCli(root, '0.1.5-rc.2')
  const version = await detectDshVersion(jailed(root, { argvPath: entry }))
  assert.equal(version, '0.1.5-rc.2')
}))

test('the install anchor outranks the argv fallback', withTempTree(async (root) => {
  const anchor = join(root, 'dsh', 'package.json')
  await writeManifest(anchor, '@deepseek-ai/dsh', '9.9.9-anchor')
  const entry = await writeFakeCli(join(root, 'other'), '8.8.8-argv')
  const version = await detectDshVersion(jailed(root, { profileContext: { installAnchor: anchor }, argvPath: entry }))
  assert.equal(version, '9.9.9-anchor')
}))

test('undetectable hosts report undefined rather than guessing', withTempTree(async (root) => {
  // No profileContext (a 0.1.5 custom composition), a bogus CLI entry, and
  // an empty plugin-local base: every source dries up.
  const version = await detectDshVersion(jailed(root))
  assert.equal(version, undefined)
}))

test('an unreadable anchor never throws; later sources still run', withTempTree(async (root) => {
  const entry = await writeFakeCli(root, '0.1.5-rc.2')
  const version = await detectDshVersion(jailed(root, {
    profileContext: { installAnchor: join(root, 'missing', 'package.json') },
    argvPath: entry,
  }))
  assert.equal(version, '0.1.5-rc.2')
}))

test('a manifest without a version field is skipped, not reported', withTempTree(async (root) => {
  const anchor = join(root, 'dsh', 'package.json')
  await mkdir(join(anchor, '..'), { recursive: true })
  await writeFile(anchor, `${JSON.stringify({ name: '@deepseek-ai/dsh' })}\n`, 'utf8')
  const version = await detectDshVersion(jailed(root, { profileContext: { installAnchor: anchor } }))
  assert.equal(version, undefined)
}))

test('a file:// install anchor is accepted as well as a plain path', withTempTree(async (root) => {
  const anchor = join(root, 'dsh', 'package.json')
  await writeManifest(anchor, '@deepseek-ai/dsh', '9.9.9-url')
  const version = await detectDshVersion(jailed(root, { profileContext: { installAnchor: pathToFileURL(anchor).href } }))
  assert.equal(version, '9.9.9-url')
}))
