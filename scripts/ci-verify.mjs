/** Run one Node leg or render both legs into GitHub Actions Summary. */
import { spawnSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs'
import { resolve } from 'node:path'

const [mode, major] = process.argv.slice(2)
const directory = resolve('.sandbox/ci')
const versions = ['0.1.7-rc.1', '0.2.0-rc.1', '0.2.0-rc.2', '0.2.1-rc.1', '0.2.1-rc.2']
const version = process.env.DSH_TEST_VERSION
if (!versions.includes(version)) throw new Error('DSH_TEST_VERSION must name a supported exact version')

if (mode === 'summary') {
  const lines = [`## DSH ${version} — Node 22 / 24`, '',
    '| Node | Setup | Verification | Install | Typecheck | Tests | Build |',
    '| --- | --- | --- | --- | --- | --- | --- |']
  for (const node of ['22', '24']) {
    let report
    try { report = JSON.parse(readFileSync(`${directory}/node-${node}.json`, 'utf8')) } catch { /* A failed setup has no report. */ }
    const status = key => report?.steps.find(step => step.name === key)?.status ?? 'not run'
    const tests = report?.counts
    const count = tests ? ` (${tests.pass} passed, ${tests.fail} failed, ${tests.skipped} skipped)` : ''
    lines.push(`| ${report?.node ?? node} | ${process.env[`SETUP_${node}`] ?? 'unknown'} | ${process.env[`VERIFY_${node}`] ?? 'unknown'} | ${status('install')} | ${status('typecheck')} | ${status('test')}${count} | ${status('build')} |`)
  }
  lines.push('', `Node 22 exact-host smoke: **${process.env.SMOKE_RESULT ?? 'not run'}**.`,
    '', 'Logs and temporary tarballs stay on the runner; no artifacts or GitHub Release are uploaded.', '')
  const text = lines.join('\n')
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, text)
  else process.stdout.write(text)
} else if (mode === 'verify' && ['22', '24'].includes(major)) {
  if (process.versions.node.split('.')[0] !== major) throw new Error(`Expected Node ${major}, got ${process.version}`)
  mkdirSync(directory, { recursive: true })
  const report = { node: process.version, dsh: version, steps: [], counts: undefined }
  const save = () => writeFileSync(`${directory}/node-${major}.json`, `${JSON.stringify(report, null, 2)}\n`)
  const run = (name, args) => {
    console.log(`::group::Node ${major}: ${name}`)
    const result = spawnSync('pnpm', args, { encoding: 'utf8', timeout: 600000, maxBuffer: 32 * 1024 * 1024 })
    process.stdout.write(result.stdout ?? '')
    process.stderr.write(result.stderr ?? '')
    if (result.error) console.error(result.error.message)
    console.log('::endgroup::')
    const status = result.status === 0 ? 'passed' : 'failed'
    report.steps.push({ name, status, exitCode: result.status })
    if (name === 'test') {
      const field = key => [...(result.stdout ?? '').matchAll(new RegExp(`^# ${key} (\\d+)`, 'gm'))].at(-1)?.[1]
      if (field('tests') !== undefined) report.counts = { total: Number(field('tests')), pass: Number(field('pass')), fail: Number(field('fail')), skipped: Number(field('skipped')) }
    }
    save()
    return status === 'passed'
  }
  // Node 24 reuses the selected cohort's lockfile; it must not silently resolve
  // different dependencies from Node 22. Install scripts never run here.
  if (run('install', ['install', '--frozen-lockfile', '--ignore-scripts'])) {
    run('typecheck', ['run', 'typecheck'])
    run('test', ['run', 'test'])
    run('build', ['run', 'build'])
  } else {
    for (const name of ['typecheck', 'test', 'build']) report.steps.push({ name, status: 'skipped' })
    save()
  }
  process.exitCode = report.steps.some(step => step.status === 'failed') ? 1 : 0
} else {
  throw new Error('Usage: node scripts/ci-verify.mjs verify <22|24> | summary')
}
