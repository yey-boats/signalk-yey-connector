#!/usr/bin/env bash
# Cut a release of signalk-yey-connector by tagging main; the tag push runs
# .github/workflows/release.yml (tests, npm pack, GitHub release with the
# tarball and the CHANGELOG section). Replaces the one-off, version-pinned
# release scripts used for 0.1.0-0.4.0 (#26).
#
# Before running it, merge a release PR that:
#   - sets "version" in package.json (and package-lock.json): npm version <v> --no-git-tag-version
#   - renames "## [Unreleased]" in CHANGELOG.md to "## [<v>] - <date>", adds a
#     fresh empty Unreleased section and the compare links at the bottom
#   - points the README install commands at v<v>
#
# Then, from a checkout of this repo:
#   scripts/release.sh 0.5.0             # checks, then tags main and pushes the tag
#   DRY_RUN=1 scripts/release.sh 0.5.0   # checks only
#   REMOTE=https://github.com/yey-boats/signalk-yey-connector.git scripts/release.sh 0.5.0
#
# Not published to npm (later).
set -euo pipefail

VERSION="${1:-}"
REMOTE="${REMOTE:-origin}"
DRY_RUN="${DRY_RUN:-0}"
TAG="v${VERSION}"
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
die() { echo "release: $*" >&2; exit 1; }

[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?$ ]] || die "usage: scripts/release.sh <version>  (e.g. 0.5.0)"
command -v git >/dev/null || die "git not found"
command -v node >/dev/null || die "node not found"
cd "$ROOT"

git fetch -q "$REMOTE" main --tags
MAIN="$(git rev-parse FETCH_HEAD)"
if ! git diff --quiet || ! git diff --cached --quiet; then die "the working tree has uncommitted changes"; fi
pkg="$(git show "$MAIN:package.json" | node -e "process.stdout.write(JSON.parse(require('fs').readFileSync(0,'utf8')).version)")"
[ "$pkg" = "$VERSION" ] || die "package.json on main is $pkg, not $VERSION: merge the release PR first"
trap 'rm -f "${TMPDIR:-/tmp}/yey-changelog.$$"' EXIT
git show "$MAIN:CHANGELOG.md" > "${TMPDIR:-/tmp}/yey-changelog.$$" 2>/dev/null || die "no CHANGELOG.md on main"
node scripts/changelog-section.js "$VERSION" "${TMPDIR:-/tmp}/yey-changelog.$$" >/dev/null \
  || die "CHANGELOG.md on main has no [$VERSION] section"
if git ls-remote --exit-code --tags "$REMOTE" "refs/tags/$TAG" >/dev/null 2>&1; then
  die "tag $TAG already exists on $REMOTE"
fi
echo "ok: main is $(git rev-parse --short "$MAIN"), package $VERSION, CHANGELOG has [$VERSION], no $TAG yet"
[ "$DRY_RUN" = 1 ] && { echo "DRY_RUN: not tagging"; exit 0; }

git tag -a "$TAG" -m "$TAG" "$MAIN"
git push "$REMOTE" "refs/tags/$TAG"
echo "pushed $TAG; the Release workflow builds the GitHub release:"
echo "  https://github.com/yey-boats/signalk-yey-connector/actions/workflows/release.yml"
