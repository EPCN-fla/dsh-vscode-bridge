import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'

const runner = fileURLToPath(new URL('../scripts/ci-verify.mjs', import.meta.url))
const require = createRequire(import.meta.url)
const hostRequire = createRequire(require.resolve('@deepseek-ai/dsh-app-boot'))
const yaml = hostRequire('js-yaml') as { load(text: string): Workflow }
interface Step { name?: string; id?: string; if?: string; run?: string; uses?: string; with?: Record<string, unknown> }
interface Workflow {
  on: { pull_request: unknown; push: { tags: string[]; branches?: unknown } }
  jobs: Record<string, { if: string; needs?: unknown; strategy?: { 'fail-fast': boolean; matrix: string }; steps: Step[] }>
}

test('CI triggers PR jobs per DSH and verifies both Node versions within each job', async () => {
  const text = await readFile(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8')
  const workflow = yaml.load(text)
  assert.deepEqual(Object.keys(workflow.on).sort(), ['pull_request', 'push'])
  assert.deepEqual(workflow.on.push, { tags: ['v*'] })
  const job = workflow.jobs.verify!
  assert.equal(job.if, "github.event_name == 'pull_request'")
  assert.equal(job.strategy?.['fail-fast'], false)
  assert.equal(job.needs, 'compatibility')
  assert.equal(job.strategy!.matrix, '${{ fromJSON(needs.compatibility.outputs.matrix) }}')
  assert.equal(workflow.jobs.compatibility!.if, "github.event_name == 'pull_request'")
  assert.equal(workflow.jobs.compatibility!.steps.at(-1)?.run, 'node scripts/ci-compatibility.mjs matrix')
  assert.doesNotMatch(text, /0\.2\.1|0\.2\.0|0\.1\.7|~4\.0\./)
  assert.deepEqual(job.steps.filter(step => step.uses === 'actions/setup-node@v4').map(step => step.with?.['node-version']), [22, 24])
  assert.equal(job.steps.find(step => step.id === 'verify22')?.run, 'node scripts/ci-verify.mjs verify 22')
  assert.equal(job.steps.find(step => step.id === 'verify24')?.run, 'node scripts/ci-verify.mjs verify 24')
  assert.match(job.steps.find(step => step.id === 'setup24')!.if!, /!cancelled\(\)/)
  assert.match(job.steps.find(step => step.id === 'verify24')!.if!, /!cancelled\(\)/)
  assert.equal(job.steps.find(step => step.name === 'Test summary')?.if, 'always()')
  const publish = workflow.jobs.publish!
  assert.match(publish.if, /refs\/tags\/v/)
  assert.equal(publish.needs, undefined)
  const commands = publish.steps.map(step => step.run ?? '').join('\n')
  assert.match(commands, /pnpm run build/)
  assert.match(commands, /npm publish --ignore-scripts/)
  assert.doesNotMatch(commands, /pnpm (?:run )?test|ci-verify|runtime-smoke|pnpm pack/)
  assert.doesNotMatch(text, /uses:.*(?:upload-artifact|download-artifact|action-gh-release)|gh release create/)
})

for (const failure of ['', 'test', 'install']) {
  test(`CI runner preserves command outcomes and summary when ${failure || 'nothing'} fails`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'bridge-ci-'))
    t.after(() => rm(root, { recursive: true, force: true }))
    await writeFile(join(root, 'package.json'), JSON.stringify({ dshCompatibility: { '9.8.7-rc.1': { cordis: '~4.0.5' } } }))
    const bin = join(root, 'bin')
    await mkdir(bin)
    const command = join(bin, 'pnpm')
    await writeFile(command, `#!${process.execPath}\nconst action = process.argv[2] === 'run' ? process.argv[3] : process.argv[2];
if (action === 'test') console.log('# tests 3\\n# pass 2\\n# fail 1\\n# skipped 0');
process.exitCode = action === process.env.FAIL_COMMAND ? 1 : 0;\n`)
    await chmod(command, 0o755)
    const major = process.versions.node.split('.')[0]!
    const env = { ...process.env, PATH: bin + delimiter + process.env.PATH, DSH_TEST_VERSION: '9.8.7-rc.1', FAIL_COMMAND: failure }
    const result = spawnSync(process.execPath, [runner, 'verify', major], { cwd: root, env, encoding: 'utf8', timeout: 10000 })
    assert.equal(result.status, failure ? 1 : 0, result.stderr)
    const report = JSON.parse(await readFile(join(root, `.sandbox/ci/node-${major}.json`), 'utf8'))
    assert.deepEqual(report.steps.map((step: { name: string }) => step.name), ['install', 'typecheck', 'test', 'build'])
    assert.equal(report.steps[3].status, failure === 'install' ? 'skipped' : 'passed')
    const summary = join(root, 'summary.md')
    const rendered = spawnSync(process.execPath, [runner, 'summary'], { cwd: root, env: { ...env, GITHUB_STEP_SUMMARY: summary, [`VERIFY_${major}`]: failure ? 'failure' : 'success', SMOKE_RESULT: 'skipped' }, encoding: 'utf8' })
    assert.equal(rendered.status, 0, rendered.stderr)
    const markdown = await readFile(summary, 'utf8')
    assert.match(markdown, /Node 22 \/ 24/)
    assert.match(markdown, /not run/)
    if (failure !== 'install') assert.match(markdown, /2 passed, 1 failed, 0 skipped/)
    if (failure) assert.match(markdown, /failed/)
  })
}
