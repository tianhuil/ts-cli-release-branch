# ts-cli-release-branch

Ship a TypeScript CLI straight from GitHub, with no npm registry and no built JavaScript committed to `main`. Users install a tag with any package manager:

```sh
npm install -g github:tianhuil/ts-cli-release-branch#v0.1.0
pnpm add -g github:tianhuil/ts-cli-release-branch#v0.1.0
bun add -g github:tianhuil/ts-cli-release-branch#v0.1.0
yarn global add github:tianhuil/ts-cli-release-branch#v0.1.0   # Yarn 1 only
npx --yes github:tianhuil/ts-cli-release-branch#v0.1.0 --version
```

Use `#release` instead of `#vX.Y.Z` for the latest release.

This repo is a working demo, and its CI is the proof: every push installs the release seven ways (`npm -g`, `pnpm -g`, `bun -g`, `yarn global`, `npx`, `pnpm dlx`, `bunx`), from both the tag and the `release` branch, and checks the version it prints.

## How it works

- `main` holds source only; `dist/` is gitignored.
- On each push to `main`, [`release.yml`](.github/workflows/release.yml) runs [`scripts/release.sh`](scripts/release.sh). If tag `v<package.json version>` doesn't exist yet, the script builds, commits `main`'s files plus `dist/` to the `release` branch, tags that commit, pushes both, and creates a GitHub Release. If the tag exists, it does nothing. **To release, bump `version`.**
- Each release commit has two parents: the previous release and the source commit on `main`.

## Rules the package must follow

| Rule | Why |
|---|---|
| `bin` points at built `.js` with `#!/usr/bin/env node` | Node won't run TypeScript from `node_modules` (`ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`), so a `.ts` bin only works for Bun users. |
| `"files": ["dist"]` in `package.json` | Without it, installers apply `.gitignore` and can drop `dist/`. `release.sh` fails if any built file would be dropped. |
| No `build`, `prepare`, `prepack`, `install`, `preinstall` or `postinstall` script in the release commit | npm then reinstalls dev dependencies on every git install, and `npm install -g` breaks. `release.sh` strips them from the release commit's `package.json` only; `main` keeps them. |

## Develop

Any package manager works on `main`; `release.sh` picks the build command from the lockfile (here, pnpm).

```sh
pnpm install
pnpm dev --version        # node src/cli.ts (Node ≥ 22.18 runs .ts outside node_modules)
pnpm test                 # node --test
pnpm build && node dist/cli.js
scripts/release.sh --dry-run   # build the release commit locally and check it; push nothing
```

`release.sh` settings are environment variables: `BUILD_CMD`, `DIST_DIR` (`dist`), `RELEASE_BRANCH` (`release`), `TAG_PREFIX` (`v`), `REMOTE` (`origin`), `GH_RELEASE` (`1`).

## Use in your repo

Copy `scripts/release.sh` and `.github/workflows/release.yml` (drop the `verify-install` job if you like), add `"files"` to `package.json`, and gitignore `dist/`.

## License

MIT
