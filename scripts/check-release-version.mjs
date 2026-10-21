/** Release floor gate: 0 = higher, 1 = refused, 2 = invalid input, 3 = tool failure. */
async function main() {
  const [version, latest, ...extra] = process.argv.slice(2)
  if (!version || !latest || extra.length) {
    console.error('release gate: expected <package-version> <latest-version>')
    return 2
  }

  let semver
  try {
    semver = (await import('semver')).default
    if (typeof semver?.valid !== 'function' || typeof semver?.gt !== 'function') throw new Error('invalid module')
  } catch {
    console.error('release gate: semver dependency unavailable; run pnpm install --frozen-lockfile')
    return 3
  }

  // Registry output must be a single valid version, never an error message or range.
  if (semver.valid(version) === null || semver.valid(latest) === null) {
    console.error('release gate: invalid package or registry latest version; refusing publication')
    return 2
  }
  if (!semver.gt(version, latest)) {
    console.error(`release gate: ${version} is not higher than latest (${latest}); refusing publication`)
    return 1
  }
  console.log(`release gate: ${version} > ${latest}`)
  return 0
}

process.exitCode = await main()
