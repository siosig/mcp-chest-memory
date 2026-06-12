# mcp-chest-memory

**English** | [日本語](README.ja.md)

**These daily frustrations end today:**

- Giving the same instructions over and over
- Answering the same questions again and again
- Watching your LLM stumble in the same place every time
- Burning through tokens so fast you keep hitting your limits

mcp-chest-memory makes all of these a thing of the past — automatically.

- **Add this MCP server — then there is nothing left for you to do.**
- **It automatically remembers what was worked on, why things failed, and
  what research concluded — across all your projects.**

**With this MCP installed, your LLM grows together with you: mistakes and
repeated questions keep decreasing, and the LLM increasingly behaves like
an extension of yourself.**

**As a welcome side effect, it also cuts your LLM token usage substantially.**

**Local-first persistent memory for coding agents, served over MCP.**
Your agent forgets everything when a session ends; chest gives it a durable,
searchable "past self" — failures it must not repeat, decisions and their
reasons, per-file edit history — stored in a single SQLite file on your machine.

One memory store spans **all your projects and all your LLM agents**: knowledge
is recalled and recorded automatically by the LLM itself, without you having to
think about it — so you stop giving the same instructions over and over.

Optimized for Claude Code (bundled skill + hooks), works with any MCP client.

This MCP server is built to be easy to adopt. It scales from personal use to
multiple machines and on to a whole project team. Start with personal use and
feel the difference for yourself — getting started solo is very easy.

## Features

- **6-layer structured memory** — `goal` / `context` / `emotion` /
  `implementation` / `realize` (failures & pitfalls, protected from
  forgetting) / `learning` (insights & decisions)
- **Hybrid recall** — SQLite FTS5 trigram full-text search fused with vector
  similarity via Reciprocal Rank Fusion, then weighted by recency heat,
  entity momentum, and importance
- **Multilingual by construction** — trigram tokenization needs no
  morphological analyzer; Japanese/Chinese/Korean and whitespace-delimited
  languages all work
- **Offline-first embeddings** — a small multilingual model
  (`multilingual-e5-small`, ONNX, ~120 MB) runs locally via transformers.js;
  no API key, no network after the one-time model download
- **Memory lifecycle** — ACT-R style activation decay, TTL expiry,
  archive-first deletion, supersession detection, sleep-mode consolidation
- **Token-saving file reads** — `chest_read_smart` caches file chunk hashes
  and returns only what changed since the last read
- **Session continuity** — work-state snapshots survive context compaction
  (Claude Code PreCompact/SessionStart hooks)
- **Three deployment profiles** — same tools, same semantics: single PC,
  LAN-shared (Docker), or WAN (nginx + TLS)

## Quick start (single PC)

Requirements: Node.js ≥ 24.

No clone needed — one command sets everything up:

```bash
npx -y -p mcp-chest-memory chest-memory-setup --yes
```

This registers the MCP server with Claude Code (it runs via
`npx -y mcp-chest-memory`), installs the `/chest-memory` skill, and wires the
hooks. The database schema is created automatically on first launch, and the
embedding model (~120 MB) downloads in the background on first use — saves
made before it is ready stay `pending` and are backfilled automatically.

### From source (development, LAN/WAN backend)

```bash
git clone https://github.com/siosig/mcp-chest-memory.git
cd mcp-chest-memory
./tools/install.sh
```

The installer is idempotent and will: build the project, create
`~/.chest-memory/`, initialize the SQLite database, prefetch the embedding
model (one-time download), register the MCP server with Claude Code, install
the `/chest-memory` skill, and wire the hooks. Restart Claude Code and try:

> "Remember this: our staging DB resets every Monday."
> "Did we hit this error before?"

Uninstall — for an npx install:

```bash
claude mcp remove -s user chest-memory
npx -y -p mcp-chest-memory chest-memory-install-hooks --remove
rm -rf ~/.claude/skills/chest-memory
rm -rf ~/.chest-memory   # only if you also want to delete your memories
```

For a source install (asks before touching your data):

```bash
./tools/uninstall.sh            # interactive
./tools/uninstall.sh --purge    # also delete ~/.chest-memory
```

### Importing your existing Claude Code history

Seed the memory store from every past session under `~/.claude/projects/`
(memories, per-file edit history, events) and from each project's curated
auto-memory files (`memory/*.md`), then backfill embeddings — all in one
command:

```bash
npx -y -p mcp-chest-memory chest-memory-import --all
```

The embedding model (~120 MB) is downloaded on first use if not already
present. Pass `--skip-embed` to skip the embedding backfill (background
maintenance will catch up later). Pass `--dry-run` to parse and report
without writing anything.

Re-running is safe: each session is wiped and re-inserted idempotently.

## Daily usage

### What you have to do: (almost) nothing

After installation, just work with Claude Code as usual. The bundled
`/chest-memory` skill teaches the agent to recall and save memories on its
own. Everything below is optional:

- Say **"remember this: ..."** to force a save of something specific
- Invoke **`/chest-memory`** to save the recent context explicitly,
  or **`/chest-memory status`** to check store health
- Ask **"did we hit this before?"** to force a recall
- Hooks are wired automatically by the installer (`chest-memory-setup` for
  npx, `install.sh --skip-hooks` to opt out for source installs): session
  auto-capture on Stop, snapshot save/restore around compaction

### What runs automatically even if you do nothing

- **On every save** (`chest_remember`): the layer is classified by the
  agent, content is stored in SQLite, the FTS5 index updates via triggers,
  the vector is embedded in-process by the local model, and `realize`-layer
  memories are auto-protected from forgetting
- **On every recall** (`chest_recall`): FTS + vector hybrid search with
  decay-aware ranking; access heat is updated so frequently used memories
  rank higher over time
- **During a session** (skill-driven): recall at task start and before
  editing files with history; saves after errors are resolved or decisions
  are made
- **On every session end** (hooks, wired by `install.sh`): the session is
  captured on Stop, and work-state snapshots survive context compaction
- **In the background after saves** (throttled, at most once per
  `CHEST_MAINTENANCE_INTERVAL_SEC`, default 10 min): activation decay
  recompute, TTL expiry and archive sweep, supersession detection,
  consolidation of cold memories, and embedding backfill for any pending
  rows. No scheduler setup is required; `chest-index up` remains available
  for manual runs

### MCP tools

| Tool | Purpose |
|---|---|
| `chest_remember` | Save a memory into a layer (with importance, TTL, supersedes) |
| `chest_recall` | Hybrid search across memories (FTS5 + vector + decay-aware ranking) |
| `chest_recall_file` | Complete edit history of a file with per-edit intent |
| `chest_update_memory` | Edit a memory in place (preserves links) |
| `chest_list_entities` | Entity overview sorted by recent activity |
| `chest_forget` | Delete by id or run risk-based auto-forgetting (realize/goal/pinned protected) |
| `chest_consolidate` | Compress cold memories into learning summaries |
| `chest_read_smart` | Diff-cached file read (returns only changed chunks) |

## Multi-PC (LAN): Docker backend

On the host that owns the data:

```bash
cd deploy
CHEST_API_TOKEN=$(openssl rand -hex 32) docker compose up -d
```

The SQLite file is persisted on the host at `deploy/data/chest.db` and
survives container re-creation. Keep a single backend replica — one writer
process owns the database.

On each client PC:

```bash
./tools/install.sh --remote http://<host-ip>:8765 --token <same token>
```

Every client now shares the same memory: a `chest_remember` on PC-A is
recallable from PC-B. The backend enforces the Bearer token even on the LAN.

## Multi-PC (WAN): publishing through nginx

1. Run the Docker backend as above (bind it to localhost if nginx runs on the
   same host: change the port mapping to `127.0.0.1:8765:8765`).
2. Copy [`deploy/nginx.conf.example`](deploy/nginx.conf.example) into your
   nginx configuration, set `server_name` and certificate paths, then
   `nginx -t && systemctl reload nginx`. The example publishes the backend
   under the `/chest-memory` path prefix (nginx strips the prefix before
   forwarding, so the backend itself is unchanged); a health probe is
   available at `https://chest.example.com/chest-memory/healthz`.
3. Register clients against the public URL including the prefix:

```bash
./tools/install.sh --remote https://chest.example.com/chest-memory --token <token>
```

Defense in depth: TLS terminates at nginx, while the backend still verifies
the Bearer token itself — a proxy misconfiguration never exposes an
unauthenticated backend. An optional HTTP Basic layer is sketched in the
example config.

## Embeddings

Embeddings are computed locally by `Xenova/multilingual-e5-small`
(quantized ONNX, 384 dimensions) via transformers.js — no API key, and fully
offline after the one-time model download (`tools/install.sh` prefetches it).

Saving never depends on embedding availability: if the model is unavailable,
the memory is stored with `embedding_status=pending` and backfilled later by
`chest-index`. Vectors are stamped with the model and dimension that produced
them; if a future release changes the bundled model, mismatched vectors are
excluded from vector recall (full-text recall is unaffected) until you
re-index:

```bash
chest-index status    # shows how many vectors don't match the current model
chest-index reembed   # resets them to pending and re-embeds
```

## How it works

### Architecture

```mermaid
flowchart LR
    subgraph client [Any client PC]
        CC[Claude Code] -->|stdio| MCP[chest-memory MCP server]
    end

    MCP -->|"local mode (default)"| DB[(chest.db SQLite + FTS5)]
    MCP -->|"remote mode: REST + Bearer token"| NG[nginx TLS - WAN only]
    NG --> API[chest-server REST backend Docker]
    MCP -.->|"LAN: direct REST"| API
    API --> DB2[(host-mounted chest.db)]

    subgraph maintenance [Background maintenance - auto after writes]
        IDX[decay / sweeps / embedding backfill] --> DB
        IDX2[same, inside the backend] --> DB2
    end
```

| Profile | Transport | Database lives | Setup |
|---|---|---|---|
| Single PC | stdio → in-process SQLite | `~/.chest-memory/chest.db` | `./tools/install.sh` |
| Multi-PC (LAN) | stdio → REST (Bearer) → Docker | host bind mount (`deploy/data/`) | `docker compose up` + `install.sh --remote` |
| Multi-PC (WAN) | stdio → nginx (TLS) → Docker | host bind mount | above + `deploy/nginx.conf.example` |

The MCP tool surface is identical in every profile: the stdio server either
executes tools in-process (local) or forwards the same JSON payload to the
backend (remote), which runs the very same executor code.


### Storage

One SQLite database (WAL mode) holds entities, memories, edges, events, file
snapshots, sessions, and consolidation audit rows. Schema is managed by
Prisma migrations; the FTS5 virtual table and its sync triggers are plain SQL
inside the same migration.

### Full-text search: FTS5 trigram

`memories_fts` indexes 3-character substrings (`tokenize='trigram
remove_diacritics 1'`). This is language-agnostic: CJK text needs no word
segmentation and no MeCab-style analyzer. Queries shorter than 3 characters
fall back to a LIKE path. Scores come from SQLite's built-in `bm25()`.

### Hybrid ranking

For a recall query both paths run:

1. **FTS path** — trigram match, ranked by bm25
2. **Vector path** — query embedded by the local model, cosine similarity
   against stored vectors (only rows whose `(model, dim)` match the current
   model), top-k

The two rankings are fused with **Reciprocal Rank Fusion**
(`1/(k + rank_fts) + 1/(k + rank_vec)`), min-max normalized to a relevance
score. The final composite is:

```
composite = (0.45·relevance + 0.25·heat + 0.15·momentum + 0.15·importance)
            × activation × ttl_penalty × supersession_penalty
```

- **heat** — access frequency/recency of the memory (hot/warm/cold/frozen)
- **momentum** — recent activity of the owning entity
- **activation** — ACT-R inspired decay computed offline by `chest-index`
  from the access log
- **ttl / supersession penalties** — soft demotion before hard expiry

### Memory lifecycle

- **Archive-first**: nothing is physically deleted on decay; rows get
  `archived_at` and drop out of default recall
- **Supersession**: a newer, near-duplicate memory (cosine ≥ 0.97, same
  entity/layer, 90-day window) archives its predecessor and records the link
- **Consolidation**: cold low-importance memories are clustered per
  (entity, layer) and compressed into one protected `learning` summary
- **Protection**: `realize`-layer and pinned (importance ≥ 0.9) memories are
  never auto-forgotten
- **Snapshots**: a per-session work-state snapshot survives context
  compaction; the SessionStart hook restores it

### Maintenance

Maintenance is self-driving: after a save, the server runs (in the
background, without delaying the response) activation recompute →
decay/archive sweep → supersession sweep → embedding backfill of pending
rows. Passes are throttled to once per `CHEST_MAINTENANCE_INTERVAL_SEC`
(default 600 s) and guarded by a file lock, so they never overlap a manual
`chest-index up` run. Set `CHEST_AUTO_MAINTENANCE=0` to disable the
automatic passes and drive everything via `chest-index` yourself.

## Configuration reference

| Variable | Default | Meaning |
|---|---|---|
| `CHEST_MODE` | `local` | `local` = in-process SQLite; `remote` = forward to REST backend |
| `CHEST_DATA_DIR` | `~/.chest-memory` | Data root (database, model cache) |
| `CHEST_DB_PATH` | `<data dir>/chest.db` | SQLite file |
| `CHEST_REMOTE_URL` | — | Backend base URL (remote mode) |
| `CHEST_API_TOKEN` | — | Shared Bearer token (backend refuses to start without it) |
| `CHEST_PORT` | `8765` | REST backend listen port |
| `CHEST_MAX_CONTENT_CHARS` | `8000` | Max memory content length |
| `CHEST_SWEEP_LIMIT` | `500` | Max rows backfilled per embedding sweep |
| `CHEST_MAINTENANCE_INTERVAL_SEC` | `600` | Min seconds between background maintenance passes |
| `CHEST_AUTO_MAINTENANCE` | `1` | Set `0` to disable write-triggered maintenance |

## Claude Code integration

- **Skill**: `/chest-memory` (installed by `install.sh`) auto-classifies the
  recent conversation into `realize` vs `learning` and saves it with the
  rationale shown; `/chest-memory status` reports store health
- **Hooks** (wired by `install.sh`, or `chest-memory-setup --yes` for npm
  installs): `chest-memory-precompact` saves a work-state snapshot before
  context compaction; `chest-memory-session-start` restores it;
  `chest-memory-sync` (Stop hook) auto-captures sessions. Re-wire any time
  with `node dist/bin/install-hooks.js`; remove with `--remove`

## Development

```bash
pnpm install
pnpm typecheck
pnpm test          # node:test against a throwaway SQLite db
pnpm build
./tools/check-rebrand.sh   # release gate: naming/history/language checks
```

## License

[MIT](LICENSE)
