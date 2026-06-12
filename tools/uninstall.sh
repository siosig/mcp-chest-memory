#!/usr/bin/env bash
# chest-memory uninstaller.
#
# Removes what tools/install.sh set up:
#   1. the MCP server registration (claude mcp remove)
#   2. the /chest-memory skill
#   3. the Claude Code hooks (Stop/PreCompact/SessionStart)
#   4. optionally the data directory (asks first; memories live there)
#
# Options:
#   --purge      delete the data directory without asking
#   --keep-data  keep the data directory without asking
#   --data-dir DIR  data directory location (default: ~/.chest-memory)

set -euo pipefail

PURGE=""
DATA_DIR="${CHEST_DATA_DIR:-$HOME/.chest-memory}"

while [ $# -gt 0 ]; do
  case "$1" in
    --purge)     PURGE="yes"; shift ;;
    --keep-data) PURGE="no"; shift ;;
    --data-dir)  DATA_DIR="${2:?--data-dir requires a path}"; shift 2 ;;
    -h|--help)   grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

say() { printf '\033[1m[chest]\033[0m %s\n' "$*"; }

# --- 1. MCP registration ------------------------------------------------------
if command -v claude >/dev/null 2>&1; then
  if claude mcp remove -s user chest-memory >/dev/null 2>&1; then
    say "MCP registration removed"
  else
    say "no MCP registration found (skipped)"
  fi
else
  say "'claude' CLI not found — remove the 'chest-memory' entry from your MCP client manually"
fi

# --- 2. skill -----------------------------------------------------------------
SKILL_DIR="$HOME/.claude/skills/chest-memory"
if [ -d "$SKILL_DIR" ]; then
  rm -rf "$SKILL_DIR"
  say "skill removed: $SKILL_DIR"
else
  say "no skill found (skipped)"
fi

# --- 3. hooks -----------------------------------------------------------------
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
if [ -f "$ROOT/dist/bin/install-hooks.js" ]; then
  node "$ROOT/dist/bin/install-hooks.js" --remove \
    || say "WARNING: hook removal failed — check ~/.claude/settings.json manually"
else
  say "dist/ not built — remove chest-memory hook entries from ~/.claude/settings.json manually if present"
fi

# --- 4. data ------------------------------------------------------------------
if [ -d "$DATA_DIR" ]; then
  if [ -z "$PURGE" ]; then
    printf '[chest] Delete memory data at %s? [y/N] ' "$DATA_DIR"
    read -r answer
    case "$answer" in
      y|Y|yes|YES) PURGE="yes" ;;
      *) PURGE="no" ;;
    esac
  fi
  if [ "$PURGE" = "yes" ]; then
    rm -rf "$DATA_DIR"
    say "data directory deleted: $DATA_DIR"
  else
    say "data directory kept: $DATA_DIR"
  fi
else
  say "no data directory found (skipped)"
fi

say "uninstall complete"
