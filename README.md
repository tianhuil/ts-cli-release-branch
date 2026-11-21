# ts-cli-release-branch

[![release workflow](https://github.com/tianhuil/ts-cli-release-branch/actions/workflows/release.yml/badge.svg)](https://github.com/tianhuil/ts-cli-release-branch/actions/workflows/release.yml)
[![latest release](https://img.shields.io/github/v/release/tianhuil/ts-cli-release-branch)](https://github.com/tianhuil/ts-cli-release-branch/releases/latest)
[![license: MIT](https://img.shields.io/github/license/tianhuil/ts-cli-release-branch)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-339933?logo=node.js&logoColor=white)](package.json)

Ship a TypeScript CLI straight from GitHub, with no npm registry and no built JavaScript committed to `main`. Users install a tag with any package manager:

```sh
npm install -g github:tianhuil/ts-cli-release-branch#v0.4.0
pnpm add -g github:tianhuil/ts-cli-release-branch#v0.4.0
bun add -g github:tianhuil/ts-cli-release-branch#v0.4.0
yarn global add github:tianhuil/ts-cli-release-branch#v0.4.0   # Yarn 1 only
npx --yes github:tianhuil/ts-cli-release-branch#v0.4.0 --version
```

Pin a tag from [Releases](https://github.com/tianhuil/ts-cli-release-branch/releases), or use `#release` for the latest. Prefer a tag with `pnpm dlx` and `bunx`: both reuse a cached copy of `#release` after it moves (`npx` refetched it).

This repo is a working demo, and its CI is the proof: every push installs the release seven ways (`npm -g`, `pnpm -g`, `bun -g`, `yarn global`, `npx`, `pnpm dlx`, `bunx`), from both the tag and the `release` branch, and checks the version it prints.

## How it works

- `main` holds source only; `dist/` is gitignored.
- On each push to `main`, [`release.yml`](.github/workflows/release.yml) runs `node scripts/release.mts publish` ([`scripts/release.mts`](scripts/release.mts)). If tag `v<package.json version>` doesn't exist yet, the script builds, commits `main`'s files plus `dist/` to the `release` branch, tags that commit, pushes both, and creates a GitHub Release. If the tag exists, it does nothing. **To release, bump `version`.**
- Each release commit has two parents: the previous release and the source commit on `main`.

## Rules the package must follow

| Rule | Why |
|---|---|
| `bin` points at built `.js` with `#!/usr/bin/env node` | Node won't run TypeScript from `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so a `.ts` bin only works for Bun users. |
| `"files": ["dist"]` in `package.json` | Without it, installers apply `.gitignore` and can drop `dist/`. `release.mts` fails if any built file would be dropped. |
| No `build`, `prepare`, `prepack`, `install`, `preinstall` or `postinstall` script in the release commit | npm then reinstalls dev dependencies on every git install, and `npm install -g` breaks. `release.mts` strips them from the release commit's `package.json` only; `main` keeps them. |

## Pitfalls

- Yarn 2+ has no global installs; use `yarn dlx`.
- Each package manager has its own global bin directory. Installing with two of them, or alongside `pnpm link --global` from a clone, puts several copies on `PATH`. Check with `which ts-cli-release-branch` and `--version`.
- To upgrade, install a newer tag. To uninstall, use that manager's remove (`npm rm -g`, `pnpm rm -g`, `bun rm -g`).

## Develop

Any package manager works on `main`; the release script picks the build command from the lockfile (here, pnpm).

```sh
pnpm install
pnpm dev --version          # node src/cli.ts (Node ≥ 22.18 runs .ts outside node_modules)
pnpm typecheck && pnpm test # tsc, then node --test (includes the release script's tests)
pnpm build && node dist/cli.js
```

## Release script

[`scripts/release.mts`](scripts/release.mts) is TypeScript that Node runs directly (Node ≥ 22.18, plus the `commander` dev dependency). It has three commands; run `node scripts/release.mts <command> --help` for each:

| Command | What it does |
|---|---|
| `publish` | What CI runs. If the tag exists, it does nothing. Otherwise it builds, checks, commits to `release`, tags, pushes, and creates a GitHub Release. |
| `check` | Builds and checks the release commit locally. It prints the commit's SHA and pushes nothing. |
| `pack [--install]` | Like `check`, then writes the tarball installers would get and prints its path. `--install` also installs it globally with npm. Use this to try a release before tagging it. |

Settings come from flags, then a JSON config file (`--config`, default `release.config.json` if present), then defaults. For example:

```json
{
  "buildCommand": "pnpm run compile",
  "distDir": "dist",
  "releaseBranch": "release",
  "tagPrefix": "v",
  "remote": "origin",
  "githubRelease": true
}
```

Unknown keys and wrong types are errors. The `.mts` extension makes Node load it as an ES module even in a package without `"type": "module"`.

## Use in your repo

1. Copy `scripts/release.mts`, `scripts/tsconfig.json` and `.github/workflows/release.yml`. Drop the `verify-install` job, or set its `BIN` to your command.
2. Add `commander` as a dev dependency, and `"files": ["dist"]` to `package.json`.
3. Gitignore `dist/`. If it is tracked, run `git rm -r --cached dist`.
4. Commit, then run `node scripts/release.mts pack --install` and check your command's `--version`.

## License

MIT
