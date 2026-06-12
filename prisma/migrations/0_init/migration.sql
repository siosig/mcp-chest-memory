-- CreateTable
CREATE TABLE "entities" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "kind" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "normalized_name" TEXT,
    "canonical_key" TEXT,
    "attributes" TEXT,
    "momentum_score" REAL NOT NULL DEFAULT 0.0,
    "momentum_at" BIGINT,
    "created_at" BIGINT NOT NULL DEFAULT (unixepoch()),
    "updated_at" BIGINT NOT NULL DEFAULT (unixepoch())
);

-- CreateTable
CREATE TABLE "memories" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "entity_id" BIGINT NOT NULL,
    "layer" TEXT NOT NULL,
    "content" TEXT NOT NULL,
    "importance" REAL NOT NULL DEFAULT 0.5,
    "protected" INTEGER NOT NULL DEFAULT 0,
    "source" TEXT,
    "created_at" BIGINT NOT NULL DEFAULT (unixepoch()),
    "last_accessed_at" BIGINT NOT NULL DEFAULT (unixepoch()),
    "access_count" INTEGER NOT NULL DEFAULT 0,
    "archived_at" BIGINT,
    "superseded_by_id" BIGINT,
    "supersession_confidence" REAL,
    "expires_at" BIGINT,
    "embedding" TEXT,
    "embedding_model" TEXT,
    "embedding_status" TEXT NOT NULL DEFAULT 'pending',
    "embedding_state_changed_at" BIGINT NOT NULL DEFAULT (unixepoch()),
    "embedding_dim" INTEGER,
    "activation_score" REAL,
    "ttl_penalty" REAL,
    "supersession_penalty" REAL,
    "activation_computed_at" BIGINT,
    CONSTRAINT "memories_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "entities" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "memories_superseded_by_id_fkey" FOREIGN KEY ("superseded_by_id") REFERENCES "memories" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "memory_access_log" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "memory_id" BIGINT NOT NULL,
    "accessed_at" BIGINT NOT NULL DEFAULT (unixepoch()),
    CONSTRAINT "memory_access_log_memory_id_fkey" FOREIGN KEY ("memory_id") REFERENCES "memories" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "edges" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "from_id" BIGINT NOT NULL,
    "to_id" BIGINT NOT NULL,
    "relation" TEXT NOT NULL,
    "weight" REAL NOT NULL DEFAULT 1.0,
    "attributes" TEXT,
    "created_at" BIGINT NOT NULL DEFAULT (unixepoch()),
    CONSTRAINT "edges_from_id_fkey" FOREIGN KEY ("from_id") REFERENCES "entities" ("id") ON DELETE CASCADE ON UPDATE CASCADE,
    CONSTRAINT "edges_to_id_fkey" FOREIGN KEY ("to_id") REFERENCES "entities" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "events" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "entity_id" BIGINT,
    "kind" TEXT NOT NULL,
    "payload" TEXT,
    "occurred_at" BIGINT NOT NULL DEFAULT (unixepoch()),
    CONSTRAINT "events_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "entities" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "file_snapshots" (
    "path" TEXT NOT NULL PRIMARY KEY,
    "content_hash" TEXT NOT NULL,
    "mtime" BIGINT NOT NULL,
    "size_bytes" BIGINT,
    "chunks" TEXT,
    "last_read_at" BIGINT NOT NULL DEFAULT (unixepoch()),
    "read_count" INTEGER NOT NULL DEFAULT 1
);

-- CreateTable
CREATE TABLE "file_facts" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "file_path" TEXT NOT NULL,
    "chunk_hash" TEXT,
    "fact" TEXT NOT NULL,
    "layer" TEXT,
    "extracted_at" BIGINT NOT NULL DEFAULT (unixepoch()),
    CONSTRAINT "file_facts_file_path_fkey" FOREIGN KEY ("file_path") REFERENCES "file_snapshots" ("path") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "sessions" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "agent_kind" TEXT,
    "started_at" BIGINT NOT NULL DEFAULT (unixepoch()),
    "last_seen_at" BIGINT NOT NULL DEFAULT (unixepoch())
);

-- CreateTable
CREATE TABLE "session_file_edits" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "session_id" TEXT NOT NULL,
    "memory_id" BIGINT,
    "file_path" TEXT NOT NULL,
    "operation" TEXT NOT NULL,
    "turn_uuid" TEXT,
    "context_snippet" TEXT,
    "occurred_at" BIGINT NOT NULL,
    CONSTRAINT "session_file_edits_memory_id_fkey" FOREIGN KEY ("memory_id") REFERENCES "memories" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "consolidations" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "learning_id" BIGINT,
    "replaced_ids" TEXT NOT NULL,
    "replaced_count" INTEGER NOT NULL,
    "entity_id" BIGINT,
    "original_layer" TEXT NOT NULL,
    "created_at" BIGINT NOT NULL DEFAULT (unixepoch()),
    CONSTRAINT "consolidations_learning_id_fkey" FOREIGN KEY ("learning_id") REFERENCES "memories" ("id") ON DELETE SET NULL ON UPDATE CASCADE,
    CONSTRAINT "consolidations_entity_id_fkey" FOREIGN KEY ("entity_id") REFERENCES "entities" ("id") ON DELETE CASCADE ON UPDATE CASCADE
);

-- CreateTable
CREATE TABLE "meta" (
    "key" TEXT NOT NULL PRIMARY KEY,
    "value" TEXT NOT NULL
);

-- CreateTable
CREATE TABLE "session_snapshots" (
    "id" INTEGER NOT NULL PRIMARY KEY AUTOINCREMENT,
    "session_id" TEXT NOT NULL,
    "snapshot_text" TEXT NOT NULL,
    "created_at" BIGINT NOT NULL DEFAULT (unixepoch())
);

-- CreateIndex
CREATE UNIQUE INDEX "entities_canonical_key_key" ON "entities"("canonical_key");

-- CreateIndex
CREATE INDEX "idx_entities_kind" ON "entities"("kind");

-- CreateIndex
CREATE INDEX "idx_entities_key" ON "entities"("canonical_key");

-- CreateIndex
CREATE INDEX "idx_entities_normalized" ON "entities"("kind", "normalized_name");

-- CreateIndex
CREATE INDEX "idx_entities_list_kind" ON "entities"("kind", "momentum_score" DESC);

-- CreateIndex
CREATE INDEX "idx_entities_list_all" ON "entities"("momentum_score" DESC, "updated_at" DESC);

-- CreateIndex
CREATE INDEX "idx_memories_entity" ON "memories"("entity_id");

-- CreateIndex
CREATE INDEX "idx_memories_layer" ON "memories"("layer");

-- CreateIndex
CREATE INDEX "idx_memories_importance" ON "memories"("importance" DESC);

-- CreateIndex
CREATE INDEX "idx_memories_protected" ON "memories"("protected");

-- CreateIndex
CREATE INDEX "idx_memories_archived" ON "memories"("archived_at");

-- CreateIndex
CREATE INDEX "idx_memories_superseded" ON "memories"("superseded_by_id");

-- CreateIndex
CREATE INDEX "idx_memories_expires" ON "memories"("expires_at");

-- CreateIndex
CREATE INDEX "idx_memories_actstale" ON "memories"("activation_computed_at");

-- CreateIndex
CREATE INDEX "idx_memories_supersession_cand" ON "memories"("entity_id", "layer", "archived_at", "created_at" DESC);

-- CreateIndex
CREATE INDEX "idx_memories_consolidate_scan" ON "memories"("protected", "archived_at", "layer", "created_at");

-- CreateIndex
CREATE INDEX "idx_memories_activation_stale" ON "memories"("archived_at", "activation_computed_at");

-- CreateIndex
CREATE INDEX "idx_memories_recall_filter" ON "memories"("entity_id", "archived_at", "superseded_by_id", "layer");

-- CreateIndex
CREATE INDEX "idx_memories_emb_status" ON "memories"("embedding_status");

-- CreateIndex
CREATE INDEX "idx_mal_memory" ON "memory_access_log"("memory_id", "accessed_at" DESC);

-- CreateIndex
CREATE INDEX "idx_edges_from" ON "edges"("from_id");

-- CreateIndex
CREATE INDEX "idx_edges_to" ON "edges"("to_id");

-- CreateIndex
CREATE INDEX "idx_edges_rel" ON "edges"("relation");

-- CreateIndex
CREATE UNIQUE INDEX "edges_from_id_to_id_relation_key" ON "edges"("from_id", "to_id", "relation");

-- CreateIndex
CREATE INDEX "idx_events_entity" ON "events"("entity_id");

-- CreateIndex
CREATE INDEX "idx_events_occurred" ON "events"("occurred_at" DESC);

-- CreateIndex
CREATE INDEX "idx_events_kind" ON "events"("kind");

-- CreateIndex
CREATE INDEX "idx_file_mtime" ON "file_snapshots"("mtime");

-- CreateIndex
CREATE INDEX "idx_file_facts_path" ON "file_facts"("file_path");

-- CreateIndex
CREATE INDEX "idx_sfe_session" ON "session_file_edits"("session_id");

-- CreateIndex
CREATE INDEX "idx_sfe_file" ON "session_file_edits"("file_path");

-- CreateIndex
CREATE INDEX "idx_sfe_memory" ON "session_file_edits"("memory_id");

-- CreateIndex
CREATE INDEX "idx_sfe_when" ON "session_file_edits"("occurred_at" DESC);

-- CreateIndex
CREATE INDEX "idx_consolidations_entity" ON "consolidations"("entity_id");

-- CreateIndex
CREATE UNIQUE INDEX "uq_session_snapshots_session" ON "session_snapshots"("session_id");

-- CreateIndex
CREATE INDEX "idx_session_snapshots_created" ON "session_snapshots"("created_at");

-- =========================================================================
-- realize-layer rows are always protected from auto-forgetting
-- =========================================================================
CREATE TRIGGER "trg_protect_realize"
  AFTER INSERT ON "memories"
  WHEN NEW."layer" = 'realize'
  BEGIN
    UPDATE "memories" SET "protected" = 1 WHERE "id" = NEW."id";
  END;

-- =========================================================================
-- FTS5 full-text index over memory content.
-- The trigram tokenizer indexes 3-character substrings, which works for
-- whitespace-delimited languages and CJK alike (no morphological analyzer).
-- =========================================================================
CREATE VIRTUAL TABLE "memories_fts" USING fts5(
  content,
  content='memories',
  content_rowid='id',
  tokenize='trigram remove_diacritics 1'
);

CREATE TRIGGER "trg_memories_fts_ai"
  AFTER INSERT ON "memories" BEGIN
    INSERT INTO memories_fts(rowid, content) VALUES (NEW.id, NEW.content);
  END;

CREATE TRIGGER "trg_memories_fts_ad"
  AFTER DELETE ON "memories" BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', OLD.id, OLD.content);
  END;

CREATE TRIGGER "trg_memories_fts_au"
  AFTER UPDATE OF "content" ON "memories" BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content) VALUES('delete', OLD.id, OLD.content);
    INSERT INTO memories_fts(rowid, content) VALUES (NEW.id, NEW.content);
  END;
