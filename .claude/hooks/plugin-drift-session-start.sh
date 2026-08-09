#!/usr/bin/env bash
# SessionStart entrypoint for plugin-drift.
# Clean → silent (exit 0, no output). Drift → FAIL lines on stdout.
set -eu

# This file lives at <repo>/.claude/hooks/ — climb two levels to the worktree.
root=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd)
# Prefer the session project dir when Claude sets it; fall back to repo root.
repo=${CLAUDE_PROJECT_DIR:-$root}
exec "$root/scripts/plugin-drift" tiny-claude-plugins --repo "$repo"
