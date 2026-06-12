---
description: "Rules for using the chest-memory MCP server from a coding agent. Defines when to recall, when to save, which of the 6 layers to use, and the must-follow constraints. Load this when working in a project that has chest-memory registered."
---

# chest-memory usage rules

chest-memory is a local-first persistent memory MCP server. It stores
structured memories in a single SQLite file and lets an agent recall its
own past across sessions and projects. Tools are exposed as
`mcp__chest-memory__chest_*`. This file defines HOW and WHEN to use them.

## Must / Must not

- [MUST] Recall before acting on a new task: call `chest_recall` (and
  `chest_recall_file` before editing a file) so prior `realize` warnings and
  decisions are not lost.
- [MUST] Save a `realize` memory immediately after an error/failure is
  understood, with `importance >= 0.8`. A failure that is fixed but not
  recorded WILL recur in another session.
- [MUST] Save a `learning` memory after a decision, insight, or belief update,
  with `importance >= 0.7`, and include the prior belief that changed.
- [MUST] Correct an existing memory with `chest_update_memory`, never with
  `chest_forget` + `chest_remember`. Delete+recreate breaks the
  `session_file_edits` links that power `chest_recall_file`.
- [MUST NOT] Demote a `realize` memory to another layer. `realize` is the
  protected "never repeat this" layer.
- [MUST NOT] Treat recalled memories as current truth. They reflect what was
  true when written; if one names a file, flag, or function, verify it still
  exists before relying on it.
- [MUST NOT] Save secrets (tokens, keys, passwords, private credentials) into
  any memory. Stored content is indexed and embedded; treat it as durable.

## The 6 layers

| Layer | What goes here | Default TTL | Auto-protected |
|---|---|---|---|
| `goal` | Project objectives and targets | none | exempt from forgetting |
| `context` | Background, timing, situational facts, who/why | 30 days | — |
| `emotion` | Tone, mood, frustration signals | 14 days | — |
| `implementation` | Code/config that worked or didn't; how it was tried | 90 days | — |
| `realize` | Failures, pitfalls, traps that must not be repeated | none | **yes** (`protected=1`) |
| `learning` | Insights, decisions, belief updates, distilled patterns | 365 days | — |

- `importance >= 0.9` pins a memory in any layer (survives all auto-forgetting).
- `realize` and active `goal` are never auto-forgotten; the rest decay.
- `context` / `emotion` / `implementation` are consolidated: once cold and
  older than 7 days, clusters of ≥ 2 per (entity, layer) are compressed into a
  single protected `learning` summary.

### importance guide

| Value | Use for |
|---|---|
| `>= 0.9` | Pin (never auto-forgotten, any layer) |
| `>= 0.8` | `realize` recommended floor |
| `>= 0.7` | `learning` recommended floor |
| `>= 0.5` | Ordinary memory |
| `< 0.5` | Short-lived note |

## Tools

| Tool | Purpose | Key parameters |
|---|---|---|
| `chest_remember` | Save into one layer. `importance >= 0.9` pins; `realize` is auto-protected | `entityName`, `entityKind` (person/company/project/concept/file/other), `layer`, `content`, `importance?`, `supersedes?`, `expiresAt?` |
| `chest_recall` | Hybrid search (FTS5 trigram + local vector via RRF) with decay-aware ranking; returns match reasons | `query`, `entityName?`, `layer?`, `band?` (hot/warm/cold/frozen), `maxTokens?` (default 2000), `limit?`, `includeArchived?`, `includeSuperseded?` |
| `chest_recall_file` | Full cross-session edit history of a file plus the user intents that drove each edit | `pathSubstring`, `maxIntents?` |
| `chest_update_memory` | Atomic in-place edit by id (keeps links). Demoting from `realize` is rejected | `memoryId`, `content?`, `layer?`, `importance?` |
| `chest_list_entities` | Entity overview by recent activity. Cheaper than recall for "what do I know about?" | `kind?`, `minMemories?`, `limit?` |
| `chest_forget` | Explicit delete by id OR risk-based auto-sweep (archive-first). `realize`/`goal`/pinned always preserved | `memoryId?`, `dryRun?` |
| `chest_consolidate` | Sleep-mode compression of cold low-importance memories into a `learning` summary | `scope?`, `minAgeDays?` (default 7), `dryRun?` |
| `chest_read_smart` | Diff-cached file read: full on first read, only changed chunks afterward | `path` (absolute), `force?` |

## When to use which

- **Start of a task** → `chest_list_entities(minMemories=5, limit=10)` then
  `chest_recall(query="<project> <keywords>", maxTokens=2000)`.
- **Before editing a file** → `chest_recall_file(pathSubstring=...)` — more
  precise than `chest_recall` for "why was this file changed", with intents.
- **Large file or second+ read** → `chest_read_smart` instead of plain read.
- **Right after an error is understood** → `chest_remember(layer="realize",
  importance=0.8–0.95)`.
- **After a decision or new insight** → `chest_remember(layer="learning",
  importance>=0.7)` with the prior belief included.
- **"did we hit this before?" / "same as last time"** →
  `chest_recall(entityName=..., band="hot")` to narrow.
- **Why/when a decision was made** → `chest_recall(layer="learning"|"goal")`
  plus `chest_recall_file`.
- **Returning from another project / new session** →
  `chest_list_entities(kind="project", minMemories=5)`.
- **Fixing a memory** → always `chest_update_memory` (never forget+remember).
- **Checking archived memories** → `chest_recall(includeArchived=true)`.

### `chest_recall` vs `chest_recall_file`

- Want semantic memories around a keyword → `chest_recall` (summary memories,
  abstracted).
- Want "why was file X edited" → `chest_recall_file` (queries every physical
  edit, each linked to the driving user intent).

## How recall ranks (so queries are effective)

Both paths run per query and fuse via Reciprocal Rank Fusion:

1. **FTS path** — FTS5 trigram match (3-char substrings, language-agnostic;
   CJK needs no segmentation), ranked by `bm25()`. Queries shorter than 3
   characters fall back to LIKE.
2. **Vector path** — query embedded by the bundled local model
   (`multilingual-e5-small`, ONNX, runs in-process, no network), cosine
   similarity against stored vectors, top-k.

Final composite:

```
composite = (0.45·relevance + 0.25·heat + 0.15·momentum + 0.15·importance)
            × activation × ttl_penalty × supersession_penalty
```

Implications for writing queries:
- Use specific, content-bearing terms; trigram matching rewards substrings.
- Frequently recalled memories gain heat and rank higher over time.

## Lifecycle (what happens without you)

- **Archive-first**: decay never physically deletes; rows get `archived_at`
  and drop out of default recall (`includeArchived=true` to see them).
- **Supersession**: a newer near-duplicate (cosine ≥ 0.97, same entity+layer,
  90-day window) archives its predecessor and records the link. Pass
  `supersedes` to `chest_remember` to do this manually.
- **Consolidation**: cold low-importance memories are clustered per
  (entity, layer) and compressed into one protected `learning` summary.
- **Forgetting risk** (Ebbinghaus-inspired): `risk = heatFactor ×
  importanceFactor × timeFactor`; `< 50` keep, `50–199` compress, `≥ 200`
  drop. `realize`/`goal`/pinned are exempt.
- **Maintenance** runs automatically (throttled) after saves: activation
  recompute → decay/archive sweep → supersession sweep → embedding backfill.
  No scheduler needed.

## Deployment modes (transparent to tool usage)

The tool surface is identical in every profile — the same JSON payload runs
the same executor whether in-process or forwarded to a backend.

| Profile | Transport | Database lives |
|---|---|---|
| Single PC | stdio → in-process SQLite | `~/.chest-memory/chest.db` |
| Multi-PC (LAN) | stdio → REST (Bearer) → Docker | host bind mount (`deploy/data/`) |
| Multi-PC (WAN) | stdio → nginx (TLS) → Docker | host bind mount |

Selected by env: `CHEST_MODE=local` (default) or `remote` with
`CHEST_REMOTE_URL` + `CHEST_API_TOKEN`. A single backend replica owns the
database (one writer process).

## Privacy

All memory data stays on your machine (or your own LAN/WAN backend) in a
single SQLite file. Embeddings are computed in-process by a bundled local
model — no API key and no network after the one-time model download. Nothing
is sent to any third-party service. Even so, do not store secrets: stored
text is indexed and durable.

## Checklist before saving

- [ ] Layer matches intent (`realize` for failures, `learning` for insights).
- [ ] `importance` follows the floors (`realize` ≥ 0.8, `learning` ≥ 0.7).
- [ ] `realize` content states the trap and how to avoid it, as a serious
      warning — not a casual note.
- [ ] No secrets in `content`.
- [ ] Correcting existing memory uses `chest_update_memory`, not forget+remember.
