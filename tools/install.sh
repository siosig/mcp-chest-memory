#!/usr/bin/env bash
# chest-memory installer (idempotent).
#
# Single-PC (default):
#   ./tools/install.sh
#     1. checks prerequisites (Node >= 22)
#     2. installs dependencies and builds dist/
#     3. creates the data directory and initializes the SQLite database
#     4. prefetches the local embedding model (skipped when cached)
#     5. registers the MCP server with Claude Code (stdio, local mode)
#     6. installs the /chest-memory skill
#
# Remote client (LAN/WAN):
#   ./tools/install.sh --remote https://chest.example.com --token <TOKEN>
#     Registers the MCP server in remote mode; steps 3-4 are skipped because
#     the backend owns the database and embeddings.
#
# Options:
#   --remote URL    register in remote mode against this backend URL
#   --token TOKEN   bearer token for --remote (required with --remote)
#   --skip-model    do not prefetch the embedding model now
#   --data-dir DIR  override the data directory (default: ~/.chest-memory)

set -euo pipefail

REMOTE_URL=""
API_TOKEN=""
SKIP_MODEL=0
DATA_DIR="${CHEST_DATA_DIR:-$HOME/.chest-memory}"

while [ $# -gt 0 ]; do
  case "$1" in
    --remote)    REMOTE_URL="${2:?--remote requires a URL}"; shift 2 ;;
    --token)     API_TOKEN="${2:?--token requires a value}"; shift 2 ;;
    --skip-model) SKIP_MODEL=1; shift ;;
    --data-dir)  DATA_DIR="${2:?--data-dir requires a path}"; shift 2 ;;
    -h|--help)   grep '^#' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "Unknown option: $1" >&2; exit 1 ;;
  esac
done

if [ -n "$REMOTE_URL" ] && [ -z "$API_TOKEN" ]; then
  echo "[chest] --remote requires --token (the backend refuses unauthenticated clients)" >&2
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

say()  { printf '\033[1m[chest]\033[0m %s\n' "$*"; }
fail() { printf '\033[31m[chest] %s\033[0m\n' "$*" >&2; exit "${2:-1}"; }

# --- 1. prerequisites -------------------------------------------------------
command -v node >/dev/null 2>&1 || fail "Node.js >= 22 is required" 1
NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 22 ] || fail "Node.js >= 22 is required (found $(node -v))" 1

PKG_MGR="npm"
if command -v pnpm >/dev/null 2>&1; then PKG_MGR="pnpm"; fi
say "using $PKG_MGR (node $(node -v))"

# --- 2. dependencies + build ------------------------------------------------
if [ ! -d node_modules ]; then
  say "installing dependencies..."
  "$PKG_MGR" install || fail "dependency installation failed" 2
fi
say "building..."
"$PKG_MGR" run build || fail "build failed" 2

DB_PATH="${CHEST_DB_PATH:-$DATA_DIR/chest.db}"

if [ -z "$REMOTE_URL" ]; then
  # --- 3. data dir + database ------------------------------------------------
  mkdir -p "$DATA_DIR"
  say "initializing database at $DB_PATH"
  DATABASE_URL="file:$DB_PATH" npx prisma migrate deploy >/dev/null || fail "database migration failed" 2
  # --- 4. embedding model ----------------------------------------------------
  if [ "$SKIP_MODEL" -eq 1 ]; then
    say "model prefetch skipped (--skip-model); it downloads on first use"
  else
    say "prefetching local embedding model (one-time download)..."
    CHEST_DATA_DIR="$DATA_DIR" node dist/bin/fetch-model.js \
      || say "WARNING: model prefetch failed — memories still save; embeddings backfill once the model is available"
  fi
fi

# --- 5. MCP registration -----------------------------------------------------
SERVER_JS="$ROOT/dist/mcp/server.js"
# Note: -e is variadic in the claude CLI, so the server name must come first.
ENV_ARGS=(-e "CHEST_DATA_DIR=$DATA_DIR" -e "CHEST_DB_PATH=$DB_PATH")
if [ -n "$REMOTE_URL" ]; then
  ENV_ARGS=(-e "CHEST_MODE=remote" -e "CHEST_REMOTE_URL=$REMOTE_URL" -e "CHEST_API_TOKEN=$API_TOKEN")
fi

if command -v claude >/dev/null 2>&1; then
  if claude mcp get chest-memory >/dev/null 2>&1; then
    say "updating existing MCP registration"
    claude mcp remove -s user chest-memory >/dev/null 2>&1 || true
  fi
  claude mcp add -s user chest-memory "${ENV_ARGS[@]}" -- node "$SERVER_JS" \
    && say "MCP server registered as 'chest-memory'" \
    || fail "claude mcp add failed" 2
else
  say "'claude' CLI not found — add this to your MCP client configuration manually:"
  if [ -n "$REMOTE_URL" ]; then
    cat <<EOF
  "chest-memory": {
    "command": "node",
    "args": ["$SERVER_JS"],
    "env": { "CHEST_MODE": "remote", "CHEST_REMOTE_URL": "$REMOTE_URL", "CHEST_API_TOKEN": "<your token>" }
  }
EOF
  else
    cat <<EOF
  "chest-memory": {
    "command": "node",
    "args": ["$SERVER_JS"],
    "env": { "CHEST_DATA_DIR": "$DATA_DIR", "CHEST_DB_PATH": "$DB_PATH" }
  }
EOF
  fi
fi

# --- 6. skill ---------------------------------------------------------------
node dist/bin/install-skill.js --force >/dev/null \
  && say "skill installed: ~/.claude/skills/chest-memory/SKILL.md" \
  || say "WARNING: skill installation failed (run: node dist/bin/install-skill.js --force)"

say "done. Restart Claude Code, then try: chest_remember / chest_recall"
if [ -z "$REMOTE_URL" ]; then
  say "data: $DB_PATH (models under $DATA_DIR/models)"
else
  say "mode: remote -> $REMOTE_URL"
fi
