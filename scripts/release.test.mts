import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, test } from 'node:test'
import type { Command } from 'commander'
import {
  binPaths,
  buildProgram,
  DEFAULTS,
  detectPackageManager,
  findUnpackedFiles,
  parseConfigFile,
  type ReleaseConfig,
  ReleaseError,
  type Run,
  stripLifecycleScripts,
} from './release.mts'

describe('stripLifecycleScripts', () => {
  test('drops install-time scripts, keeps the rest and the indentation', () => {
    const raw =
      '{\n\t"name": "x",\n\t"scripts": {\n\t\t"build": "tsc",\n\t\t"prepare": "tsc",\n\t\t"test": "node --test"\n\t}\n}\n'
    assert.equal(stripLifecycleScripts(raw), '{\n\t"name": "x",\n\t"scripts": {\n\t\t"test": "node --test"\n\t}\n}\n')
  })

  test('removes "scripts" once it is empty', () => {
    assert.equal(stripLifecycleScripts('{"name":"x","scripts":{"build":"tsc"}}'), '{\n  "name": "x"\n}\n')
  })
})

test('findUnpackedFiles lists built files the pack left out', () => {
  assert.deepEqual(findUnpackedFiles(['bin/x.js', 'package.json'], ['dist/a.js', 'bin/x.js']), ['dist/a.js'])
  assert.deepEqual(findUnpackedFiles(['dist/a.js'], ['dist/a.js']), [])
})

test('detectPackageManager reads the lockfile', () => {
  assert.equal(
    detectPackageManager((f) => f === 'pnpm-lock.yaml'),
    'pnpm',
  )
  assert.equal(
    detectPackageManager((f) => f === 'bun.lock'),
    'bun',
  )
  assert.equal(
    detectPackageManager((f) => f === 'yarn.lock'),
    'yarn',
  )
  assert.equal(
    detectPackageManager(() => false),
    'npm',
  )
})

test('binPaths normalizes string and object forms', () => {
  assert.deepEqual(binPaths({ bin: './dist/cli.js' }), ['dist/cli.js'])
  assert.deepEqual(binPaths({ bin: { a: 'dist/a.js', b: './dist/b.js' } }), ['dist/a.js', 'dist/b.js'])
  assert.throws(() => binPaths({}), ReleaseError)
})

describe('parseConfigFile', () => {
  test('accepts known keys', () => {
    assert.deepEqual(parseConfigFile('{"distDir":"out","githubRelease":false}', 'c.json'), {
      distDir: 'out',
      githubRelease: false,
    })
  })

  test('rejects unknown keys and wrong types', () => {
    assert.throws(() => parseConfigFile('{"dist":"out"}', 'c.json'), /unknown key "dist"/)
    assert.throws(() => parseConfigFile('{"distDir":1}', 'c.json'), /"distDir" must be a string/)
    assert.throws(() => parseConfigFile('[]', 'c.json'), /expected a JSON object/)
  })
})

describe('buildProgram', () => {
  const parse = (args: string[]): { mode: string; config: ReleaseConfig; install: boolean } => {
    let seen: { mode: string; config: ReleaseConfig; install: boolean } | undefined
    const run: Run = (mode, config, { install }) => {
      seen = { mode, config, install }
    }
    const program = buildProgram(run)
    for (const command of [program, ...program.commands] satisfies Command[]) {
      command.exitOverride().configureOutput({ writeErr: () => {}, writeOut: () => {} })
    }
    program.parse(args, { from: 'user' })
    assert.ok(seen, 'action did not run')
    return seen
  }

  test('defaults apply when there are no flags and no release.config.json', () => {
    assert.deepEqual(parse(['check']).config, DEFAULTS)
  })

  test('a missing --config file is an error', () => {
    assert.throws(() => parse(['--config', 'missing.json', 'check']), /missing\.json not found/)
  })

  test('flags override the config file, which overrides defaults', () => {
    const dir = mkdtempSync(join(tmpdir(), 'release-test-'))
    const config = join(dir, 'release.json')
    writeFileSync(config, JSON.stringify({ distDir: 'out', tagPrefix: 'release-', githubRelease: false }))
    const { mode, config: resolved } = parse(['--config', config, '--dist-dir', 'build', 'publish'])
    assert.equal(mode, 'publish')
    assert.deepEqual(resolved, { ...DEFAULTS, distDir: 'build', tagPrefix: 'release-', githubRelease: false })
  })

  test('--no-github-release and --install reach the action', () => {
    assert.equal(parse(['publish', '--no-github-release']).config.githubRelease, false)
    assert.equal(parse(['pack', '--install']).install, true)
  })

  test('rejects flags on the wrong command', () => {
    assert.throws(() => parse(['publish', '--install']), { code: 'commander.unknownOption' })
  })
})
