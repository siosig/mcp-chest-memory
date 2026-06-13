-- Migration: Tokenized FTS for multilingual recall quality
-- Adds content_tokenized column and recreates memories_fts with unicode61 tokenizer.
-- Safe to re-apply: column addition is idempotent via conditional block.

-- Add content_tokenized column (nullable; backfilled via `chest-index migrate`).
ALTER TABLE "memories" ADD COLUMN "content_tokenized" TEXT;

-- Drop old FTS triggers (trigram over content).
DROP TRIGGER IF EXISTS "trg_memories_fts_ai";
DROP TRIGGER IF EXISTS "trg_memories_fts_ad";
DROP TRIGGER IF EXISTS "trg_memories_fts_au";

-- Drop old FTS virtual table (derived data — no data loss).
DROP TABLE IF EXISTS "memories_fts";

-- Recreate FTS5 with unicode61 tokenizer over content_tokenized.
-- Rows with content_tokenized IS NULL are excluded from FTS matches
-- until `chest-index migrate` backfills them.
CREATE VIRTUAL TABLE "memories_fts" USING fts5(
  content_tokenized,
  content='memories',
  content_rowid='id',
  tokenize='unicode61 remove_diacritics 1'
);

-- New FTS triggers that maintain content_tokenized in the index.
CREATE TRIGGER "trg_memories_fts_ai"
  AFTER INSERT ON "memories" BEGIN
    INSERT INTO memories_fts(rowid, content_tokenized)
    VALUES (NEW.id, NEW.content_tokenized);
  END;

CREATE TRIGGER "trg_memories_fts_ad"
  AFTER DELETE ON "memories" BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content_tokenized)
    VALUES ('delete', OLD.id, OLD.content_tokenized);
  END;

CREATE TRIGGER "trg_memories_fts_au"
  AFTER UPDATE OF "content_tokenized" ON "memories" BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content_tokenized)
    VALUES ('delete', OLD.id, OLD.content_tokenized);
    INSERT INTO memories_fts(rowid, content_tokenized)
    VALUES (NEW.id, NEW.content_tokenized);
  END;
