#!/usr/bin/env bash
# Publish HEAD plus a fresh build as a commit on the release branch, tagged <TAG_PREFIX><package.json version>.
# Does nothing if that tag already exists on the remote, so it is safe to run on every push.
#
# Usage: scripts/release.sh [--dry-run]
#   --dry-run  build and create the release commit locally, print its SHA, push nothing.
#
# Env (default):
#   BUILD_CMD       (<pm> run build; pm detected from the lockfile)
#   DIST_DIR        (dist)
#   RELEASE_BRANCH  (release)
#   TAG_PREFIX      (v)
#   REMOTE          (origin)
#   GH_RELEASE      (1: also run `gh release create`; needs GH_TOKEN in CI)
set -euo pipefail

DIST_DIR=${DIST_DIR:-dist}
RELEASE_BRANCH=${RELEASE_BRANCH:-release}
TAG_PREFIX=${TAG_PREFIX:-v}
REMOTE=${REMOTE:-origin}
GH_RELEASE=${GH_RELEASE:-1}
DRY_RUN=0
case "${1:-}" in
  --dry-run) DRY_RUN=1 ;;
  "") ;;
  *) echo "usage: $0 [--dry-run]" >&2; exit 2 ;;
esac

cd "$(git rev-parse --show-toplevel)"

if [ -z "${BUILD_CMD:-}" ]; then
  if [ -f pnpm-lock.yaml ]; then pm=pnpm
  elif [ -f bun.lock ] || [ -f bun.lockb ]; then pm=bun
  elif [ -f yarn.lock ]; then pm=yarn
  else pm=npm; fi
  BUILD_CMD="$pm run build"
fi

version=$(node -p 'require("./package.json").version')
tag="$TAG_PREFIX$version"
if [ -n "${GITHUB_OUTPUT:-}" ]; then
  echo "tag=$tag" >> "$GITHUB_OUTPUT"
fi

rc=0; git ls-remote --exit-code --tags "$REMOTE" "refs/tags/$tag" >/dev/null || rc=$?
if [ "$rc" = 0 ]; then
  echo "$tag already exists on $REMOTE; nothing to release." >&2
  exit 0
elif [ "$rc" != 2 ]; then
  echo "Could not list tags on $REMOTE (git ls-remote exit $rc)." >&2
  exit 1
fi
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Working tree has uncommitted changes; commit or stash them first." >&2
  exit 1
fi

parents=()
if git fetch --quiet "$REMOTE" "+refs/heads/$RELEASE_BRANCH:refs/remotes/$REMOTE/$RELEASE_BRANCH" 2>/dev/null; then
  parents+=(-p "$REMOTE/$RELEASE_BRANCH")
fi
parents+=(-p HEAD)

rm -rf "$DIST_DIR"
echo "+ $BUILD_CMD" >&2
$BUILD_CMD >&2 # stdout is reserved for the --dry-run SHA

# Every bin must be built JS that plain Node can run.
node -e '
  const fs = require("fs"), pkg = require("./package.json");
  const bins = typeof pkg.bin === "string" ? [pkg.bin] : Object.values(pkg.bin ?? {});
  if (!bins.length) throw new Error("package.json has no bin");
  for (const b of bins) {
    if (!fs.existsSync(b)) throw new Error(`bin ${b} was not built`);
    if (!fs.readFileSync(b, "utf8").startsWith("#!/usr/bin/env node")) throw new Error(`bin ${b} must start with #!/usr/bin/env node`);
    fs.chmodSync(b, 0o755);
  }'

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

# Build the release tree in a scratch index so the caller's index is untouched.
export GIT_INDEX_FILE="$tmp/index"
git read-tree HEAD
git add -f "$DIST_DIR"
# npm runs a full devDependency install for a git dependency that has any of these scripts,
# and `npm install -g` from git then breaks. The release ships built code, so drop them.
pkg_blob=$(node -e '
  const fs = require("fs"), raw = fs.readFileSync("package.json", "utf8"), pkg = JSON.parse(raw);
  for (const k of ["preinstall", "install", "postinstall", "prepare", "prepack", "build"]) delete pkg.scripts?.[k];
  const indent = raw.match(/^[ \t]+/m)?.[0] ?? 2;
  process.stdout.write(JSON.stringify(pkg, null, indent) + "\n");' | git hash-object -w --stdin)
git update-index --cacheinfo "100644,$pkg_blob,package.json"
tree=$(git write-tree)
unset GIT_INDEX_FILE
commit=$(git commit-tree "$tree" "${parents[@]}" -m "Release $tag" -m "Source: $(git rev-parse HEAD)")

# Installers pack the tree with .gitignore rules unless `files` says otherwise; check none of the build is dropped.
mkdir "$tmp/pkg"
git archive "$commit" | tar -x -C "$tmp/pkg"
(cd "$tmp/pkg" && npm pack --dry-run --json --ignore-scripts 2>/dev/null) > "$tmp/pack.json"
git ls-tree -r --name-only "$commit" -- "$DIST_DIR" > "$tmp/built.txt"
node -e '
  const fs = require("fs"), [packJson, builtTxt, dist] = process.argv.slice(1);
  const packed = new Set(JSON.parse(fs.readFileSync(packJson, "utf8"))[0].files.map(f => f.path));
  const missing = fs.readFileSync(builtTxt, "utf8").split("\n").filter(f => f && !packed.has(f));
  if (missing.length) {
    console.error(`Installs would drop these built files: ${missing.join(", ")}`);
    console.error(`Add "${dist}" to "files" in package.json.`);
    process.exit(1);
  }' "$tmp/pack.json" "$tmp/built.txt" "$DIST_DIR"

if [ "$DRY_RUN" = 1 ]; then
  echo "Dry run: release commit $commit for $tag (not pushed). Inspect: git show --stat $commit" >&2
  echo "$commit"
  exit 0
fi

git tag -a "$tag" -m "Release $tag" "$commit"
git push --atomic "$REMOTE" "$commit:refs/heads/$RELEASE_BRANCH" "refs/tags/$tag"
if [ "$GH_RELEASE" = 1 ]; then
  gh release create "$tag" --verify-tag --title "$tag" --generate-notes
fi
echo "Released $tag ($commit)." >&2
