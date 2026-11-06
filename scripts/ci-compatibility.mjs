/** Dependency-free CI metadata reader; package.json is the compatibility source. */
import { readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { resolve } from 'node:path'

const number = '(?:0|[1-9][0-9]*)'
const identifier = '(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)'
const cordisPeerNames = ['@deepseek-ai/cordis-plugin-group', '@deepseek-ai/cordis-plugin-include', '@deepseek-ai/cordis-plugin-loader']
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
    const nodes = config?.node ?? [22, 24]
    const cordisPeers = config?.cordisPeers ?? {}
    if (!config || typeof config !== 'object' || Array.isArray(config)
      || typeof config.cordis !== 'string' || !/^~?\d+\.\d+\.\d+$/.test(config.cordis)
      || !Array.isArray(nodes) || nodes.length === 0
      || nodes.some(node => ![22, 24].includes(node)) || new Set(nodes).size !== nodes.length
      || typeof cordisPeers !== 'object' || Array.isArray(cordisPeers)
      || Object.entries(cordisPeers).some(([name, range]) => !cordisPeerNames.includes(name)
        || typeof range !== 'string' || !/^~?\d+\.\d+\.\d+$/.test(range))
      || Object.keys(config).some(key => !['cordis', 'node', 'cordisPeers'].includes(key))) {
      throw new Error(`dshCompatibility ${version} requires cordis, optional unique Node majors (22 and/or 24), and valid cordisPeers`)
    }
  }
  return { manifest, entries }
}

function main() {
  const [mode, version] = process.argv.slice(2)
  const { manifest, entries } = readCompatibility()
  if (mode === 'matrix') {
    const matrix = JSON.stringify({ include: Object.entries(entries).map(([version, config]) => ({
      'dsh-version': version, node: config.node ?? [22, 24],
    })) })
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
    for (const name of cordisPeerNames) {
      const selected = entries[version].cordisPeers?.[name]
      if (selected === undefined && Object.hasOwn(dependencies, name)) {
        delete dependencies[name]
        changed = true
      } else if (selected !== undefined && dependencies[name] !== selected) {
        dependencies[name] = selected
        changed = true
      }
    }
    if (changed) writeFileSync('package.json', `${JSON.stringify(manifest, null, 2)}\n`)
    console.log(`changed=${changed}`)
    if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `changed=${changed}\n`)
  } else {
    throw new Error('Usage: node scripts/ci-compatibility.mjs matrix | select <version>')
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main()
