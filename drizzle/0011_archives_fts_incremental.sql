-- 0011 — Phase 6.2 Stage S2 follow-up: make the archive FTS index independent
-- of task message history.
--
-- WHY: migration 0010 synced `archives_fts` by DELETEing the task's row and
-- recomputing `group_concat(am.content)` over ALL of the task's agent_messages
-- on EVERY message insert/update. The runner upserts on each `message.part.updated`
-- delta, so ingestion cost grew linearly with session history — O(n²) per
-- session on the engine's single-writer hot path (measured 87µs→5.1ms inserting
-- messages 0→8000; 200 streaming upserts against a 300-message session ≈ 6.3s).
--
-- FIX (Option B — simplest and safest): stop aggregating message text into the
-- task FTS row and drop the `agent_messages` triggers entirely. `archives_fts`
-- now indexes only the task's title/description and its (few) artifact text, so
-- every sync cost is bounded by the task's artifact count, never its message
-- count. Message content stays searchable through the archive repository's LIKE
-- branch, which is now ALWAYS present for `q` (MAJOR #1 fix in
-- src/server/repositories/archive-repo.ts), so this loses no public recall.
--
-- ADDITIVE-ONLY NOTE: this migration DROPs `archives_fts`, but that is an FTS5
-- VIRTUAL table, not a real table — it owns no foreign keys, holds no
-- user-execution rows, and is rebuildable from the real tables. Recreating a
-- virtual table therefore does not violate the additive-only rule for REAL
-- tables and cannot orphan a reference. No real table is dropped/rebuilt. No
-- in-file PRAGMA (a no-op inside the migrator's single transaction). A one-time
-- backfill repopulates the index from `tasks` + `artifacts`;
-- `PRAGMA foreign_key_check` stays empty (verified by the migration tests).
--
-- The table shape is intentionally unchanged (`task_id UNINDEXED, title,
-- description, artifact_text, tokenize='unicode61'`) so `hasArchiveFts` and the
-- repository's MATCH clause are unaffected.
DROP TRIGGER IF EXISTS archives_fts_tasks_ai;--> statement-breakpoint
DROP TRIGGER IF EXISTS archives_fts_tasks_au;--> statement-breakpoint
DROP TRIGGER IF EXISTS archives_fts_tasks_ad;--> statement-breakpoint
DROP TRIGGER IF EXISTS archives_fts_artifacts_ai;--> statement-breakpoint
DROP TRIGGER IF EXISTS archives_fts_artifacts_au;--> statement-breakpoint
DROP TRIGGER IF EXISTS archives_fts_artifacts_ad;--> statement-breakpoint
DROP TRIGGER IF EXISTS archives_fts_agent_messages_ai;--> statement-breakpoint
DROP TRIGGER IF EXISTS archives_fts_agent_messages_au;--> statement-breakpoint
DROP TRIGGER IF EXISTS archives_fts_agent_messages_ad;--> statement-breakpoint
DROP TABLE IF EXISTS archives_fts;--> statement-breakpoint
CREATE VIRTUAL TABLE archives_fts USING fts5(task_id UNINDEXED, title, description, artifact_text, tokenize='unicode61');--> statement-breakpoint
INSERT INTO archives_fts(task_id,title,description,artifact_text)
SELECT t.id, t.title, t.description,
  COALESCE((SELECT group_concat(a.content,' ') FROM artifacts a WHERE a.task_id=t.id),'')
FROM tasks t;--> statement-breakpoint
CREATE TRIGGER archives_fts_tasks_ai AFTER INSERT ON tasks BEGIN
  DELETE FROM archives_fts WHERE task_id = NEW.id;
  INSERT INTO archives_fts(task_id,title,description,artifact_text)
  SELECT t.id, t.title, t.description,
    COALESCE((SELECT group_concat(a.content,' ') FROM artifacts a WHERE a.task_id=t.id),'')
  FROM tasks t WHERE t.id = NEW.id;
END;--> statement-breakpoint
CREATE TRIGGER archives_fts_tasks_au AFTER UPDATE ON tasks BEGIN
  DELETE FROM archives_fts WHERE task_id = OLD.id;
  INSERT INTO archives_fts(task_id,title,description,artifact_text)
  SELECT t.id, t.title, t.description,
    COALESCE((SELECT group_concat(a.content,' ') FROM artifacts a WHERE a.task_id=t.id),'')
  FROM tasks t WHERE t.id = NEW.id;
END;--> statement-breakpoint
CREATE TRIGGER archives_fts_tasks_ad AFTER DELETE ON tasks BEGIN
  DELETE FROM archives_fts WHERE task_id = OLD.id;
END;--> statement-breakpoint
CREATE TRIGGER archives_fts_artifacts_ai AFTER INSERT ON artifacts BEGIN
  DELETE FROM archives_fts WHERE task_id = NEW.task_id;
  INSERT INTO archives_fts(task_id,title,description,artifact_text)
  SELECT t.id, t.title, t.description,
    COALESCE((SELECT group_concat(a.content,' ') FROM artifacts a WHERE a.task_id=t.id),'')
  FROM tasks t WHERE t.id = NEW.task_id;
END;--> statement-breakpoint
CREATE TRIGGER archives_fts_artifacts_au AFTER UPDATE ON artifacts BEGIN
  DELETE FROM archives_fts WHERE task_id = OLD.task_id;
  INSERT INTO archives_fts(task_id,title,description,artifact_text)
  SELECT t.id, t.title, t.description,
    COALESCE((SELECT group_concat(a.content,' ') FROM artifacts a WHERE a.task_id=t.id),'')
  FROM tasks t WHERE t.id = OLD.task_id;
  DELETE FROM archives_fts WHERE task_id = NEW.task_id;
  INSERT INTO archives_fts(task_id,title,description,artifact_text)
  SELECT t.id, t.title, t.description,
    COALESCE((SELECT group_concat(a.content,' ') FROM artifacts a WHERE a.task_id=t.id),'')
  FROM tasks t WHERE t.id = NEW.task_id;
END;--> statement-breakpoint
CREATE TRIGGER archives_fts_artifacts_ad AFTER DELETE ON artifacts BEGIN
  DELETE FROM archives_fts WHERE task_id = OLD.task_id;
  INSERT INTO archives_fts(task_id,title,description,artifact_text)
  SELECT t.id, t.title, t.description,
    COALESCE((SELECT group_concat(a.content,' ') FROM artifacts a WHERE a.task_id=t.id),'')
  FROM tasks t WHERE t.id = OLD.task_id;
END;
