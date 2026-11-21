#!/usr/bin/env node
// Publish this package as a commit on a release branch (HEAD plus the built output), tagged <prefix><version>.
// Run `node scripts/release.mts --help`. Needs Node >= 22.18 (runs .mts directly) and the `commander` dev dependency.
import { execFileSync, execSync, spawnSync } from 'node:child_process'
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Command, Option } from 'commander'

export interface ReleaseConfig {
  buildCommand: string | undefined
  distDir: string
  releaseBranch: string
  tagPrefix: string
  remote: string
  githubRelease: boolean
}

export const DEFAULTS: ReleaseConfig = {
  buildCommand: undefined,
  distDir: 'dist',
  releaseBranch: 'release',
  tagPrefix: 'v',
  remote: 'origin',
  githubRelease: true,
}

type StringKey = Exclude<keyof ReleaseConfig, 'githubRelease'>
const STRING_KEYS: readonly StringKey[] = ['buildCommand', 'distDir', 'releaseBranch', 'tagPrefix', 'remote']
const isStringKey = (key: string): key is StringKey => STRING_KEYS.some((k) => k === key)

// npm reinstalls devDependencies for a git dependency with any of these, and `npm i -g` from git then breaks.
export const LIFECYCLE_SCRIPTS = ['preinstall', 'install', 'postinstall', 'prepare', 'prepack', 'build'] as const

interface PackageJson {
  version?: unknown
  bin?: unknown
  scripts?: Record<string, string>
  [key: string]: unknown
}

interface PackResult {
  filename: string
  files: { path: string }[]
}

export class ReleaseError extends Error {}

type Mode = 'publish' | 'check' | 'pack'
export type Run = (mode: Mode, config: ReleaseConfig, options: { install: boolean }) => void

export function parseConfigFile(text: string, path: string): Partial<ReleaseConfig> {
  const data: unknown = JSON.parse(text)
  if (typeof data !== 'object' || data === null || Array.isArray(data)) {
    throw new ReleaseError(`${path}: expected a JSON object`)
  }
  const config: Partial<ReleaseConfig> = {}
  for (const [key, value] of Object.entries(data)) {
    if (key === '$schema') continue
    if (key === 'githubRelease') {
      if (typeof value !== 'boolean') throw new ReleaseError(`${path}: "githubRelease" must be a boolean`)
      config.githubRelease = value
    } else if (isStringKey(key)) {
      if (typeof value !== 'string') throw new ReleaseError(`${path}: "${key}" must be a string`)
      config[key] = value
    } else {
      throw new ReleaseError(`${path}: unknown key "${key}"; allowed: ${[...STRING_KEYS, 'githubRelease'].join(', ')}`)
    }
  }
  return config
}

export const mergeConfig = (file: Partial<ReleaseConfig>, cli: Partial<ReleaseConfig>): ReleaseConfig => ({
  ...DEFAULTS,
  ...file,
  ...cli,
})

export function detectPackageManager(has: (file: string) => boolean): 'pnpm' | 'bun' | 'yarn' | 'npm' {
  if (has('pnpm-lock.yaml')) return 'pnpm'
  if (has('bun.lock') || has('bun.lockb')) return 'bun'
  if (has('yarn.lock')) return 'yarn'
  return 'npm'
}

export function stripLifecycleScripts(raw: string): string {
  const pkg: PackageJson = JSON.parse(raw)
  if (pkg.scripts) {
    for (const name of LIFECYCLE_SCRIPTS) delete pkg.scripts[name]
    if (Object.keys(pkg.scripts).length === 0) delete pkg.scripts
  }
  const indent = raw.match(/^[ \t]+/m)?.[0] ?? 2
  return `${JSON.stringify(pkg, null, indent)}\n`
}

export function binPaths(pkg: PackageJson): string[] {
  const bins = typeof pkg.bin === 'string' ? [pkg.bin] : Object.values(pkg.bin ?? {})
  if (bins.length === 0) throw new ReleaseError('package.json has no "bin"')
  return bins.map((bin) => {
    if (typeof bin !== 'string') throw new ReleaseError('package.json "bin" values must be strings')
    return posix.normalize(bin)
  })
}

export const findUnpackedFiles = (packed: readonly string[], built: readonly string[]): string[] => {
  const included = new Set(packed)
  return built.filter((file) => !included.has(file))
}

const log = (message: string): void => {
  process.stderr.write(`${message}\n`)
}

function git(args: string[], options: { env?: NodeJS.ProcessEnv; input?: string } = {}): string {
  return execFileSync('git', args, {
    encoding: 'utf8',
    env: options.env ?? process.env,
    input: options.input,
    stdio: ['pipe', 'pipe', 'inherit'],
  }).trim()
}

function tagExists(remote: string, tag: string): boolean {
  const { status } = spawnSync('git', ['ls-remote', '--exit-code', '--tags', remote, `refs/tags/${tag}`], {
    stdio: ['ignore', 'ignore', 'inherit'],
  })
  if (status === 0) return true
  if (status === 2) return false
  throw new ReleaseError(`Could not list tags on ${remote} (git ls-remote exit ${status}).`)
}

function fetchReleaseBranch({ remote, releaseBranch }: ReleaseConfig): boolean {
  const refspec = `+refs/heads/${releaseBranch}:refs/remotes/${remote}/${releaseBranch}`
  return spawnSync('git', ['fetch', '--quiet', remote, refspec], { stdio: 'ignore' }).status === 0
}

function checkBins(bins: readonly string[]): void {
  for (const bin of bins) {
    if (!existsSync(bin)) throw new ReleaseError(`bin ${bin} was not built`)
    if (!readFileSync(bin, 'utf8').startsWith('#!/usr/bin/env node')) {
      throw new ReleaseError(`bin ${bin} must start with #!/usr/bin/env node`)
    }
  }
}

// Builds the release tree in a scratch index so the caller's index is untouched.
function commitRelease(config: ReleaseConfig, tag: string, rawPackageJson: string, bins: readonly string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'release-index-'))
  try {
    const env = { ...process.env, GIT_INDEX_FILE: join(dir, 'index') }
    git(['read-tree', 'HEAD'], { env })
    git(['add', '-f', config.distDir], { env })
    const blob = git(['hash-object', '-w', '--stdin'], { input: stripLifecycleScripts(rawPackageJson) })
    git(['update-index', '--cacheinfo', `100644,${blob},package.json`], { env })
    for (const bin of bins) git(['update-index', '--chmod=+x', bin], { env })
    const tree = git(['write-tree'], { env })
    const parents = fetchReleaseBranch(config) ? [`${config.remote}/${config.releaseBranch}`, 'HEAD'] : ['HEAD']
    const source = git(['rev-parse', 'HEAD'])
    return git(['commit-tree', tree, ...parents.flatMap((p) => ['-p', p]), '-m', `Release ${tag}`, '-m', `Source: ${source}`])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

// Packs the release commit the way installers do; writes a tarball only when asked.
function packCommit(commit: string, workDir: string, write: boolean): { files: string[]; tarball: string } {
  const pkgDir = join(workDir, 'package')
  const tar = join(workDir, 'release.tar')
  mkdirSync(pkgDir)
  git(['archive', '--format=tar', '-o', tar, commit])
  execFileSync('tar', ['-xf', tar, '-C', pkgDir])
  const output = execSync(`npm pack --json --ignore-scripts${write ? '' : ' --dry-run'}`, {
    cwd: pkgDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  })
  const [result]: PackResult[] = JSON.parse(output)
  if (!result) throw new ReleaseError('npm pack printed no result')
  return { files: result.files.map((f) => f.path), tarball: join(pkgDir, result.filename) }
}

export const release: Run = (mode, config, { install }) => {
  process.chdir(git(['rev-parse', '--show-toplevel']))
  const rawPackageJson = readFileSync('package.json', 'utf8')
  const pkg: PackageJson = JSON.parse(rawPackageJson)
  if (typeof pkg.version !== 'string') throw new ReleaseError('package.json has no "version"')
  const tag = `${config.tagPrefix}${pkg.version}`
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `tag=${tag}\n`)

  if (tagExists(config.remote, tag)) {
    if (mode === 'publish') {
      log(`${tag} already exists on ${config.remote}; nothing to release.`)
      return
    }
    log(`${tag} already exists on ${config.remote}; building anyway.`)
  }
  if (git(['status', '--porcelain', '--untracked-files=no'])) {
    throw new ReleaseError('Working tree has uncommitted changes; commit or stash them first.')
  }

  rmSync(config.distDir, { recursive: true, force: true })
  const buildCommand = config.buildCommand ?? `${detectPackageManager(existsSync)} run build`
  log(`+ ${buildCommand}`)
  execSync(buildCommand, { stdio: ['ignore', 2, 2] }) // stdout is reserved for the result
  const bins = binPaths(pkg)
  checkBins(bins)

  const commit = commitRelease(config, tag, rawPackageJson, bins)
  const workDir = mkdtempSync(join(tmpdir(), 'release-'))
  let keepWorkDir = false
  try {
    const { files, tarball } = packCommit(commit, workDir, mode === 'pack')
    const built = git(['ls-tree', '-r', '--name-only', commit, '--', config.distDir]).split('\n').filter(Boolean)
    const missing = findUnpackedFiles(files, built)
    if (missing.length > 0) {
      throw new ReleaseError(
        `Installs would drop these built files: ${missing.join(', ')}\nAdd "${config.distDir}" to "files" in package.json.`,
      )
    }

    if (mode === 'check') {
      log(`Release commit ${commit} for ${tag} passed all checks (not pushed). Inspect: git show --stat ${commit}`)
      process.stdout.write(`${commit}\n`)
      return
    }
    if (mode === 'pack') {
      keepWorkDir = true
      log(`Packed release commit ${commit} for ${tag}.`)
      process.stdout.write(`${tarball}\n`)
      if (install) execSync(`npm install -g ${JSON.stringify(tarball)}`, { stdio: ['ignore', 2, 2] })
      return
    }

    git(['tag', '-a', tag, '-m', `Release ${tag}`, commit])
    git(['push', '--atomic', config.remote, `${commit}:refs/heads/${config.releaseBranch}`, `refs/tags/${tag}`])
    if (config.githubRelease) {
      execFileSync('gh', ['release', 'create', tag, '--verify-tag', '--title', tag, '--generate-notes'], {
        stdio: ['ignore', 2, 2],
      })
    }
    log(`Released ${tag} (${commit}).`)
  } finally {
    if (!keepWorkDir) rmSync(workDir, { recursive: true, force: true })
  }
}

function resolveConfig(command: Command): ReleaseConfig {
  const options = command.optsWithGlobals()
  const fromCli = (key: string): boolean => command.getOptionValueSourceWithGlobals(key) === 'cli'
  const configPath = resolve(git(['rev-parse', '--show-toplevel']), String(options.config))
  let file: Partial<ReleaseConfig> = {}
  if (existsSync(configPath)) file = parseConfigFile(readFileSync(configPath, 'utf8'), configPath)
  else if (fromCli('config')) throw new ReleaseError(`Config file ${configPath} not found.`)

  const cli: Partial<ReleaseConfig> = {}
  for (const key of STRING_KEYS) if (fromCli(key)) cli[key] = String(options[key])
  if (fromCli('githubRelease')) cli.githubRelease = options.githubRelease === true
  return mergeConfig(file, cli)
}

export function buildProgram(run: Run = release): Command {
  const program = new Command('release.mts')
    .description(
      'Publish this package as a commit on a release branch: HEAD plus the built output, tagged <prefix><version>.\n' +
        'Users then install it with `npm i -g github:<owner>/<repo>#<tag>` (or pnpm, bun, npx).\n' +
        'Settings come from flags, then the config file, then the defaults shown.',
    )
    .showHelpAfterError()
    .addOption(
      new Option('-c, --config <file>', 'JSON file of settings, keyed by the camelCase flag names; relative to the repo root').default(
        'release.config.json',
        'release.config.json, if present',
      ),
    )
    .addOption(
      new Option(
        '--build-command <cmd>',
        'shell command that builds the output (default: "<pm> run build", <pm> from the lockfile)',
      ),
    )
    .addOption(new Option('--dist-dir <dir>', 'build output directory, added to the release commit').default(DEFAULTS.distDir))
    .addOption(new Option('--release-branch <name>', 'branch that holds the releases').default(DEFAULTS.releaseBranch))
    .addOption(new Option('--tag-prefix <prefix>', 'prefix before the package.json version in tag names').default(DEFAULTS.tagPrefix))
    .addOption(new Option('--remote <name>', 'git remote to read tags from and push to').default(DEFAULTS.remote))
    .addHelpText(
      'after',
      `
Examples:
  node scripts/release.mts check               # build and check the next release locally
  node scripts/release.mts pack --install      # install it globally as users would, before tagging
  node scripts/release.mts publish             # what CI runs on every push to main`,
    )

  program
    .command('publish')
    .summary('build, commit to the release branch, tag, push, and create a GitHub Release')
    .description(
      'If tag <prefix><version> already exists on the remote, print that and exit 0, so it is safe to run on every push.\n' +
        'Otherwise build, check, commit to the release branch, tag, push both atomically, and run `gh release create` (needs GH_TOKEN in CI).',
    )
    .option('--no-github-release', 'skip `gh release create`')
    .action((_options: unknown, command: Command) => run('publish', resolveConfig(command), { install: false }))

  program
    .command('check')
    .summary('build and check the release commit; print its SHA; push nothing')
    .description(
      'Build, create the release commit locally, and check that installers would include every built file.\n' +
        'Prints the commit SHA on stdout. Runs even if the tag already exists.',
    )
    .action((_options: unknown, command: Command) => run('check', resolveConfig(command), { install: false }))

  program
    .command('pack')
    .summary('like check, then pack the release into a tarball and print its path')
    .description('Like `check`, then write the tarball that installers would get and print its path on stdout.')
    .option('--install', 'also install the tarball globally with npm')
    .action((options: { install?: boolean }, command: Command) =>
      run('pack', resolveConfig(command), { install: options.install === true }),
    )

  return program
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    buildProgram().parse()
  } catch (error) {
    log(error instanceof Error ? error.message : String(error))
    process.exit(1)
  }
}
