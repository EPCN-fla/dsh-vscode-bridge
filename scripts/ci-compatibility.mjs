/** Dependency-free CI metadata reader; package.json is the compatibility source. */
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const number = '(?:0|[1-9][0-9]*)'
const identifier = '(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)'
const exactVersion = new RegExp(`^${number}\\.${number}\\.${number}(?:-${identifier}(?:\\.${identifier})*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$`)

/** Read validated exact host versions before dependencies have been installed. */
export function readCompatibility(path = 'package.json') {
  const manifest = JSON.parse(readFileSync(path, 'utf8'))
  const entries = manifest.dshCompatibility
  if (!entries || typeof entries !== 'object' || Array.isArray(entries) || Object.keys(entries).length === 0) {
    throw new Error('package.json dshCompatibility must be a non-empty version map')
  }
  for (const [version, config] of Object.entries(entries)) {
    if (!exactVersion.test(version)) throw new Error('dshCompatibility keys must be exact DSH versions, not ranges or tags')
    if (!config || typeof config !== 'object' || Array.isArray(config)
      || typeof config.cordis !== 'string' || !/^~?\d+\.\d+\.\d+$/.test(config.cordis)
      || Object.keys(config).some(key => key !== 'cordis')) {
      throw new Error(`dshCompatibility ${version} requires a cordis version (exact or tilde)`)
    }
  }
  return { manifest, entries }
}

function main() {
  const [mode, version] = process.argv.slice(2)
  const { manifest, entries } = readCompatibility()
  if (mode === 'matrix') {
    const matrix = JSON.stringify({ 'dsh-version': Object.keys(entries) })
    console.log(matrix)
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `matrix=${matrix}\n`)
  } else if (mode === 'select') {
    if (!Object.hasOwn(entries, version ?? '')) throw new Error('Selected DSH version is not declared in dshCompatibility')
    let changed = false
    const dependencies = manifest.devDependencies
    const packages = Object.keys(dependencies ?? {}).filter(name => name.startsWith('@deepseek-ai/dsh-'))
    if (packages.length === 0 || !dependencies['@deepseek-ai/cordis']) throw new Error('Missing DSH/Cordis development dependencies')
    for (const name of packages) {
      if (dependencies[name] !== version) { dependencies[name] = version; changed = true }
    }
    if (dependencies['@deepseek-ai/cordis'] !== entries[version].cordis) {
      dependencies['@deepseek-ai/cordis'] = entries[version].cordis
      changed = true
    }
    if (changed) writeFileSync('package.json', `${JSON.stringify(manifest, null, 2)}\n`)
    console.log(`changed=${changed}`)
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`)
  } else {
    throw new Error('Usage: node scripts/ci-compatibility.mjs matrix | select <version>')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main()
