---
name: chest-memory
description: |
  Persistent cross-session memory. Invoke /chest-memory to analyze the recent
  conversation and automatically save it to the right memory layer (realize =
  failures/pitfalls, learning = insights/decisions), with the classification
  rationale shown. Also fires on these moments without being asked:
  (1) a new task starts, (2) before editing a file that may have history,
  (3) right after an error or failure is resolved, (4) right after a success,
  decision, or new insight, (5) the user says "remember this" / "did we do
  this before?" / "same error again".
  Triggers (EN): remember / recall / memory / before / last time / previously / same as before / history / use chest
  Triggers (JA): 記憶 / 覚えて / 覚えておいて / 忘れて / 前に / 前回 / また同じ / そういえば
  Error keywords: failed / broken / stuck / error / bug / doesn't work / same error again / 失敗 / エラー / ハマった
  Decision keywords: decided / let's go with / settled on / pivot / switch to / 決めた / 方針 / 方向転換
---

# /chest-memory — auto-save the current context to persistent memory

chest-memory stores structured memories in six layers and recalls them with
hybrid (full-text + vector) search. Saving is cheap; recalling is what makes
the next session smarter. Default behavior of this skill: **classify the
recent conversation and save it via `chest_remember`, showing your rationale.**

## Modes

| Invocation | Behavior |
|---|---|
| `/chest-memory` | Analyze the recent context, auto-classify, save, report rationale |
| `/chest-memory status` | Show memory store health (see Status mode) |
| `/chest-memory <free text>` | Save the given text, still auto-classifying the layer |

## Auto-classification procedure

1. Look at the last few exchanges and identify the *most valuable durable
   fact* — not the chit-chat, but what a future session would need.
2. Pick the layer with this decision order (first match wins):

   | Signal in context | Layer | Why |
   |---|---|---|
   | An error/failure occurred, a trap was discovered, something must never be repeated | `realize` | Pain records; auto-protected from forgetting |
   | A new insight, a belief update, a decision with reasoning, a technique that worked | `learning` | Growth log; consolidation target |
   | A stated objective for the project ("we want to ship X") | `goal` | Drives prioritization |
   | Background/timing facts ("demo on Friday") | `context` | Explains the why later |
   | Code/config that worked or didn't, with specifics | `implementation` | Reproducibility |
   | User's emotional state worth remembering | `emotion` | Tone calibration |

   Natural-language aliases resolve automatically: `decisions`/`insights`/`learned`
   → `learning`; `warnings`/`rules`/`pitfalls` → `realize`.

3. Call `chest_remember` with:
   - `entity_name` / `entity_kind`: the project, file, or concept the fact is about
   - `layer`: from step 2
   - `content`: one dense, self-contained paragraph (include error messages,
     versions, file paths — future sessions have zero other context)
   - `importance`: 0.8+ for realize, 0.7+ for learning/decisions, 1.0 to pin
4. **Report the classification rationale to the user** in one short line, e.g.:
   `Saved as realize (an error and its root cause were just resolved): <summary>`.

## Recall habits (do these without being asked)

- **Task start**: `chest_recall({ query: "<task keywords>" })` — check for
  prior realizes and learnings before planning.
- **Before editing a file**: `chest_recall_file({ path_substring: "<file>" })`
  — the file's edit history explains why it looks the way it does.
- **"Did we solve this before?" / same error again**: `chest_recall` with the
  error message as the query.
- **Re-reading a known file**: prefer `chest_read_smart` over a plain read —
  it returns only changed chunks and saves tokens.

## Status mode (`/chest-memory status`)

Run `chest-index status` via Bash if available; otherwise summarize from
`chest_list_entities` + a broad `chest_recall`. Report: total memories by
embedding status, and whether any vectors need `chest-index reembed`
(after an embedding model change).

## Notes

- `realize`-layer and pinned (importance ≥ 0.9) memories are protected from
  auto-forgetting; prefer `chest_update_memory` over delete-and-recreate.
- Memories work in any language — store them in the language the user used.
- When a memory turns out to be wrong, update it (`chest_update_memory`) or
  supersede it by saving the correction with `supersedes: [<old id>]`.
