#!/usr/bin/env bash
# First-run bootstrap: seed the chest-memory database from your existing
# Claude Code history (~/.claude/projects/*/*.jsonl).
#
# What it does:
#   1. builds dist/ if missing and ensures the SQLite database is initialized
#   2. imports every past session (memories, file-edit history, events)
#   3. backfills embeddings for the imported memories with the local model
#
# Safe to re-run: imports are idempotent per session (existing rows for a
# session are wiped and re-inserted), and the embedding backfill only touches
# rows that are still pending.
#
# Usage:
#   ./tools/bootstrap-import.sh                 import everything
#   ./tools/bootstrap-import.sh --dry-run       parse and report, write nothing
#   ./tools/bootstrap-import.sh <projectDir>..  import only the given
#                                               ~/.claude/projects/<dir> dirs
#   ./tools/bootstrap-import.sh --skip-embed    skip the embedding backfill
#   ./tools/bootstrap-import.sh --data-dir DIR  override data dir (default ~/.chest-memory)

set -euo pipefail

DRY_RUN=0
SKIP_EMBED=0
DATA_DIR="${CHEST_DATA_DIR:-$HOME/.chest-memory}"
PROJECT_DIRS=()

while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run)    DRY_RUN=1; shift ;;
    --skip-embed) SKIP_EMBED=1; shift ;;
    --data-dir)   DATA_DIR="${2:?--data-dir requires a path}"; shift 2 ;;
    -h|--help)    grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    --*)          echo "Unknown option: $1" >&2; exit 1 ;;
    *)            PROJECT_DIRS+=("$1"); shift ;;
  esac
done

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

say()  { printf '\033[1m[chest]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[chest] %s\033[0m\n' "$*" >&2; exit "${2:-1}"; }

CLAUDE_PROJECTS="$HOME/.claude/projects"
[ -d "$CLAUDE_PROJECTS" ] || fail "$CLAUDE_PROJECTS not found — nothing to import" 1

DB_PATH="${CHEST_DB_PATH:-$DATA_DIR/chest.db}"
export CHEST_DATA_DIR="$DATA_DIR"
export CHEST_DB_PATH="$DB_PATH"

# --- 1. build + database --------------------------------------------------
if [ ! -f dist/bin/import-sessions.js ]; then
  say "dist/ not found — building..."
  PKG_MGR="npm"; command -v pnpm >/dev/null 2>&1 && PKG_MGR="pnpm"
  "$PKG_MGR" run build || fail "build failed" 2
fi

if [ "$DRY_RUN" -eq 0 ]; then
  mkdir -p "$DATA_DIR"
  say "ensuring database schema at $DB_PATH"
  DATABASE_URL="file:$DB_PATH" npx prisma migrate deploy >/dev/null || fail "database migration failed" 2
fi

# --- 2. import past sessions ------------------------------------------------
IMPORT_ARGS=()
[ "$DRY_RUN" -eq 1 ] && IMPORT_ARGS+=(--dry-run)
if [ ${#PROJECT_DIRS[@]} -gt 0 ]; then
  IMPORT_ARGS+=("${PROJECT_DIRS[@]}")
else
  IMPORT_ARGS+=(--all)
fi

say "importing Claude Code sessions from $CLAUDE_PROJECTS ..."
node dist/bin/import-sessions.js "${IMPORT_ARGS[@]}" || fail "session import failed" 2

if [ "$DRY_RUN" -eq 1 ]; then
  say "dry run complete — nothing was written"
  exit 0
fi

# --- 3. embedding backfill ----------------------------------------------------
if [ "$SKIP_EMBED" -eq 1 ]; then
  say "embedding backfill skipped (--skip-embed); 'chest-index up --embed-cycle' will catch up later"
else
  say "backfilling embeddings (first run downloads the model if needed)..."
  # Large sweep limit: drain the whole import in one pass. If the model is
  # unavailable the sweep reports 0 embedded and rows stay pending — the
  # periodic chest-index run picks them up later.
  node dist/cli/chest-index.js up --embed-cycle --sweep-limit 1000000 --quiet \
    || say "WARNING: embedding backfill failed — rows stay pending and will be retried by chest-index"
fi

say "bootstrap complete. Check the result with: node dist/cli/chest-index.js status"
