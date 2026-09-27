-- 0010 — Phase 6.2 Stage S2: additive FTS5 archive index.
--
-- ADDITIVE ONLY. This migration creates a standalone (non-external-content)
-- FTS5 virtual table plus AFTER INSERT/UPDATE/DELETE sync triggers on the
-- source tables. It performs NO `DROP`/rebuild of any real table, emits NO
-- `PRAGMA`, and creates NO foreign-key relationships, so it cannot invalidate
-- existing data or references.
--
-- FK-safety: the boot-time runner (src/lib/db/migrate.ts) executes the whole
-- migration chain inside one transaction with `foreign_keys` disabled.
-- `CREATE VIRTUAL TABLE`, `CREATE TRIGGER` and the backfill `INSERT` are all
-- legal there, and `PRAGMA foreign_key_check` stays empty afterwards (covered
-- by tests/integration/migration-chain-head.test.ts and
-- migration-phase6-data-loss.test.ts).
--
-- The index aggregates all four archive-searchable text sources for a task:
--   tasks.title
--   tasks.description
--   artifacts.content      (artifacts.task_id -> tasks.id)
--   agent_messages.content (agent_messages.session_id -> execution_sessions.task_id)
-- The archive repository uses it automatically when present and falls back to
-- the original `LIKE` path when it is missing (or when a query cannot be
-- represented faithfully by FTS tokenisation).
CREATE VIRTUAL TABLE archives_fts USING fts5(task_id UNINDEXED, title, description, artifact_text, tokenize='unicode61');--> statement-breakpoint
INSERT INTO archives_fts(task_id,title,description,artifact_text)
SELECT t.id, t.title, t.description,
  COALESCE((SELECT group_concat(a.content,' ') FROM artifacts a WHERE a.task_id=t.id),'')
  || ' ' ||
  COALESCE((SELECT group_concat(am.content,' ') FROM agent_messages am JOIN execution_sessions s ON s.id=am.session_id WHERE s.task_id=t.id),'')
FROM tasks t;--> statement-breakpoint
CREATE TRIGGER archives_fts_tasks_ai AFTER INSERT ON tasks BEGIN
  DELETE FROM archives_fts WHERE task_id = NEW.id;
  INSERT INTO archives_fts(task_id,title,description,artifact_text)
  SELECT t.id, t.title, t.description,
    COALESCE((SELECT group_concat(a.content,' ') FROM artifacts a WHERE a.task_id=t.id),'')
    || ' ' ||
    COALESCE((SELECT group_concat(am.content,' ') FROM agent_messages am JOIN execution_sessions s ON s.id=am.session_id WHERE s.task_id=t.id),'')
  FROM tasks t WHERE t.id = NEW.id;
END;--> statement-breakpoint
CREATE TRIGGER archives_fts_tasks_au AFTER UPDATE ON tasks BEGIN
  DELETE FROM archives_fts WHERE task_id = OLD.id;
  INSERT INTO archives_fts(task_id,title,description,artifact_text)
  SELECT t.id, t.title, t.description,
    COALESCE((SELECT group_concat(a.content,' ') FROM artifacts a WHERE a.task_id=t.id),'')
    || ' ' ||
    COALESCE((SELECT group_concat(am.content,' ') FROM agent_messages am JOIN execution_sessions s ON s.id=am.session_id WHERE s.task_id=t.id),'')
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
    || ' ' ||
    COALESCE((SELECT group_concat(am.content,' ') FROM agent_messages am JOIN execution_sessions s ON s.id=am.session_id WHERE s.task_id=t.id),'')
  FROM tasks t WHERE t.id = NEW.task_id;
END;--> statement-breakpoint
CREATE TRIGGER archives_fts_artifacts_au AFTER UPDATE ON artifacts BEGIN
  DELETE FROM archives_fts WHERE task_id = OLD.task_id;
  INSERT INTO archives_fts(task_id,title,description,artifact_text)
  SELECT t.id, t.title, t.description,
    COALESCE((SELECT group_concat(a.content,' ') FROM artifacts a WHERE a.task_id=t.id),'')
    || ' ' ||
    COALESCE((SELECT group_concat(am.content,' ') FROM agent_messages am JOIN execution_sessions s ON s.id=am.session_id WHERE s.task_id=t.id),'')
  FROM tasks t WHERE t.id = OLD.task_id;
  DELETE FROM archives_fts WHERE task_id = NEW.task_id;
  INSERT INTO archives_fts(task_id,title,description,artifact_text)
  SELECT t.id, t.title, t.description,
    COALESCE((SELECT group_concat(a.content,' ') FROM artifacts a WHERE a.task_id=t.id),'')
    || ' ' ||
    COALESCE((SELECT group_concat(am.content,' ') FROM agent_messages am JOIN execution_sessions s ON s.id=am.session_id WHERE s.task_id=t.id),'')
  FROM tasks t WHERE t.id = NEW.task_id;
END;--> statement-breakpoint
CREATE TRIGGER archives_fts_artifacts_ad AFTER DELETE ON artifacts BEGIN
  DELETE FROM archives_fts WHERE task_id = OLD.task_id;
  INSERT INTO archives_fts(task_id,title,description,artifact_text)
  SELECT t.id, t.title, t.description,
    COALESCE((SELECT group_concat(a.content,' ') FROM artifacts a WHERE a.task_id=t.id),'')
    || ' ' ||
    COALESCE((SELECT group_concat(am.content,' ') FROM agent_messages am JOIN execution_sessions s ON s.id=am.session_id WHERE s.task_id=t.id),'')
  FROM tasks t WHERE t.id = OLD.task_id;
END;--> statement-breakpoint
CREATE TRIGGER archives_fts_agent_messages_ai AFTER INSERT ON agent_messages BEGIN
  DELETE FROM archives_fts WHERE task_id = (SELECT es.task_id FROM execution_sessions es WHERE es.id = NEW.session_id);
  INSERT INTO archives_fts(task_id,title,description,artifact_text)
  SELECT t.id, t.title, t.description,
    COALESCE((SELECT group_concat(a.content,' ') FROM artifacts a WHERE a.task_id=t.id),'')
    || ' ' ||
    COALESCE((SELECT group_concat(am.content,' ') FROM agent_messages am JOIN execution_sessions s ON s.id=am.session_id WHERE s.task_id=t.id),'')
  FROM tasks t WHERE t.id = (SELECT es.task_id FROM execution_sessions es WHERE es.id = NEW.session_id);
END;--> statement-breakpoint
CREATE TRIGGER archives_fts_agent_messages_au AFTER UPDATE ON agent_messages BEGIN
  DELETE FROM archives_fts WHERE task_id = (SELECT es.task_id FROM execution_sessions es WHERE es.id = OLD.session_id);
  INSERT INTO archives_fts(task_id,title,description,artifact_text)
  SELECT t.id, t.title, t.description,
    COALESCE((SELECT group_concat(a.content,' ') FROM artifacts a WHERE a.task_id=t.id),'')
    || ' ' ||
    COALESCE((SELECT group_concat(am.content,' ') FROM agent_messages am JOIN execution_sessions s ON s.id=am.session_id WHERE s.task_id=t.id),'')
  FROM tasks t WHERE t.id = (SELECT es.task_id FROM execution_sessions es WHERE es.id = OLD.session_id);
  DELETE FROM archives_fts WHERE task_id = (SELECT es.task_id FROM execution_sessions es WHERE es.id = NEW.session_id);
  INSERT INTO archives_fts(task_id,title,description,artifact_text)
  SELECT t.id, t.title, t.description,
    COALESCE((SELECT group_concat(a.content,' ') FROM artifacts a WHERE a.task_id=t.id),'')
    || ' ' ||
    COALESCE((SELECT group_concat(am.content,' ') FROM agent_messages am JOIN execution_sessions s ON s.id=am.session_id WHERE s.task_id=t.id),'')
  FROM tasks t WHERE t.id = (SELECT es.task_id FROM execution_sessions es WHERE es.id = NEW.session_id);
END;--> statement-breakpoint
CREATE TRIGGER archives_fts_agent_messages_ad AFTER DELETE ON agent_messages BEGIN
  DELETE FROM archives_fts WHERE task_id = (SELECT es.task_id FROM execution_sessions es WHERE es.id = OLD.session_id);
  INSERT INTO archives_fts(task_id,title,description,artifact_text)
  SELECT t.id, t.title, t.description,
    COALESCE((SELECT group_concat(a.content,' ') FROM artifacts a WHERE a.task_id=t.id),'')
    || ' ' ||
    COALESCE((SELECT group_concat(am.content,' ') FROM agent_messages am JOIN execution_sessions s ON s.id=am.session_id WHERE s.task_id=t.id),'')
  FROM tasks t WHERE t.id = (SELECT es.task_id FROM execution_sessions es WHERE es.id = OLD.session_id);
END;
