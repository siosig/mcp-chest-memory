#!/usr/bin/env bash
# Pre-release gate: verifies the public tree and history are clean.
#
#   1. no occurrence of the legacy project name (case-insensitive)
#   2. no occurrence of the legacy layer name as a word
#   3. no AI-assistant trailers in commit messages
#   4. no Japanese text left in tracked source/docs (fixture data in test/ is allowed)
#
# Exit code 0 = clean, 1 = violations found.

set -uo pipefail
cd "$(dirname "$0")/.."

FAIL=0
LEGACY_NAME="link""see"   # split so this script never matches itself
LEGACY_LAYER="cav""eat"

note() { printf '%s\n' "$*"; }

# --- 1. legacy project name ---------------------------------------------------
hits=$(git ls-files -z | xargs -0 grep -lis "$LEGACY_NAME" 2>/dev/null || true)
if [ -n "$hits" ]; then
  note "FAIL: legacy project name found in:"; note "$hits"; FAIL=1
else
  note "OK: legacy project name absent"
fi

# --- 2. legacy layer name -----------------------------------------------------
hits=$(git ls-files -z | xargs -0 grep -liws "$LEGACY_LAYER" 2>/dev/null || true)
if [ -n "$hits" ]; then
  note "FAIL: legacy layer name found in:"; note "$hits"; FAIL=1
else
  note "OK: legacy layer name absent"
fi

# --- 3. commit trailers ---------------------------------------------------------
if git rev-parse HEAD >/dev/null 2>&1; then
  trailers=$(git log --format='%H %B' | grep -niE 'co-authored-by|generated with' || true)
  if [ -n "$trailers" ]; then
    note "FAIL: assistant trailers found in commit history:"; note "$trailers"; FAIL=1
  else
    note "OK: commit history clean"
  fi
else
  note "SKIP: no commits yet (history check)"
fi

# --- 4. Japanese text in tracked files ------------------------------------------
# Allowed locations:
#   - test/                      multilingual search fixtures
#   - src/skill/SKILL.md         Japanese trigger phrases (product feature)
#   - session-extractor/parser   regex literals matching Japanese user input
# Everything else must be English-only.
hits=$(git ls-files -z -- ':!test/' ':!src/skill/SKILL.md' \
  ':!src/lib/session-extractor.ts' ':!src/lib/session-parser.ts' \
  | xargs -0 grep -lP '[\p{Hiragana}\p{Katakana}]' 2>/dev/null || true)
if [ -n "$hits" ]; then
  note "FAIL: Japanese text found outside test fixtures / skill triggers:"; note "$hits"; FAIL=1
else
  note "OK: no Japanese text outside allowed locations"
fi

if [ "$FAIL" -eq 0 ]; then
  note "check-rebrand: ALL CLEAN"
else
  note "check-rebrand: VIOLATIONS FOUND"
fi
exit "$FAIL"
