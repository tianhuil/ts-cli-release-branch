#!/usr/bin/env bash
# Pack the next release exactly as users would install it, without pushing or tagging anything.
# Usage: scripts/try-release.sh [--install]
#   Prints the tarball path. --install also installs it globally with npm.
#   Then: `<cmd> --version`, or `pnpm add -g <tarball>` / `bun add -g <tarball>`.
set -euo pipefail

install=0
case "${1:-}" in
  --install) install=1 ;;
  "") ;;
  *) echo "usage: $0 [--install]" >&2; exit 2 ;;
esac

cd "$(git rev-parse --show-toplevel)"
commit=$(scripts/release.sh --dry-run)
[ -n "$commit" ] || { echo "release.sh --dry-run printed no commit" >&2; exit 1; }

out=$(mktemp -d)
mkdir "$out/pkg"
git archive "$commit" | tar -x -C "$out/pkg"
tgz=$(cd "$out/pkg" && npm pack --json --ignore-scripts --pack-destination "$out" 2>/dev/null |
  node -e 'console.log(JSON.parse(require("fs").readFileSync(0, "utf8"))[0].filename)')
echo "Packed release commit $commit" >&2
echo "$out/$tgz"

if [ "$install" = 1 ]; then
  npm install -g "$out/$tgz" >&2
fi
