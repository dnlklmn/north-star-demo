#!/usr/bin/env bash
#
# Symlink backend/.venv in the current git worktree to the canonical venv
# in the main repo. Run this once after `git worktree add` so you can do
#   cd backend && source .venv/bin/activate
# from the worktree the same way you do from the main checkout.
#
# Why this exists: backend/.venv is gitignored, so a fresh worktree has no
# venv until you create one. Symlinking avoids both the duplication
# (~hundreds of MB per worktree) and the "which venv is active?" footgun.
#
# Idempotent: re-running on a worktree that already has the symlink is a
# no-op. Refuses to clobber a real (non-symlink) .venv directory — if one
# exists, you've installed deps locally and the script gets out of the way.

set -euo pipefail

# Resolve the main repo's root. `--git-common-dir` returns the .git dir
# shared across worktrees (always points at the main repo), so its parent
# is the main repo's working directory.
GIT_COMMON_DIR=$(git rev-parse --git-common-dir)
MAIN_REPO_ROOT=$(cd "$(dirname "$GIT_COMMON_DIR")" && pwd)
WORKTREE_ROOT=$(git rev-parse --show-toplevel)

if [ "$MAIN_REPO_ROOT" = "$WORKTREE_ROOT" ]; then
    echo "Already in the main repo — nothing to symlink."
    exit 0
fi

CANONICAL_VENV="$MAIN_REPO_ROOT/backend/.venv"
WORKTREE_VENV="$WORKTREE_ROOT/backend/.venv"

if [ ! -d "$CANONICAL_VENV" ]; then
    echo "No venv at $CANONICAL_VENV — create it in the main repo first:" >&2
    echo "  cd $MAIN_REPO_ROOT/backend && python -m venv .venv && pip install -e ." >&2
    exit 1
fi

if [ -L "$WORKTREE_VENV" ]; then
    existing=$(readlink "$WORKTREE_VENV")
    if [ "$existing" = "$CANONICAL_VENV" ]; then
        echo "✓ $WORKTREE_VENV already linked to $CANONICAL_VENV"
        exit 0
    fi
    echo "Replacing stale symlink ($existing → $CANONICAL_VENV)"
    rm "$WORKTREE_VENV"
elif [ -e "$WORKTREE_VENV" ]; then
    echo "Refusing to overwrite real directory at $WORKTREE_VENV." >&2
    echo "If you meant to use the canonical venv, rm -rf it yourself first." >&2
    exit 1
fi

ln -s "$CANONICAL_VENV" "$WORKTREE_VENV"
echo "✓ Linked $WORKTREE_VENV → $CANONICAL_VENV"
echo "  Now you can: cd backend && source .venv/bin/activate"
