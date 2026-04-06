#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT_DIR"

BUMP_TYPE="${1:-patch}"
BRANCH="${2:-main}"

case "$BUMP_TYPE" in
  patch|minor|major)
    ;;
  *)
    echo "Usage: scripts/release.sh [patch|minor|major] [branch]"
    exit 1
    ;;
esac

if [[ -n "$(git status --short)" ]]; then
  echo "Working tree is not clean. Commit or stash your changes before releasing."
  exit 1
fi

echo "Releasing a $BUMP_TYPE version from branch '$BRANCH'..."
npm version "$BUMP_TYPE"
git push origin "$BRANCH" --follow-tags

echo "Release pushed. GitHub Actions should now build, tag, and publish the release."
