-- Full-text search over the knowledge base (SQLite FTS5), kept in sync with
-- kb_entries by triggers. The D1 store ranks matches with bm25().
CREATE VIRTUAL TABLE `kb_fts` USING fts5(
	`title`,
	`content`,
	`tags`,
	content='kb_entries',
	content_rowid='rowid'
);
--> statement-breakpoint
CREATE TRIGGER `kb_entries_fts_insert` AFTER INSERT ON `kb_entries` BEGIN
	INSERT INTO kb_fts(rowid, title, content, tags) VALUES (new.rowid, new.title, new.content, coalesce(new.tags, ''));
END;
--> statement-breakpoint
CREATE TRIGGER `kb_entries_fts_delete` AFTER DELETE ON `kb_entries` BEGIN
	INSERT INTO kb_fts(kb_fts, rowid, title, content, tags) VALUES ('delete', old.rowid, old.title, old.content, coalesce(old.tags, ''));
END;
--> statement-breakpoint
CREATE TRIGGER `kb_entries_fts_update` AFTER UPDATE ON `kb_entries` BEGIN
	INSERT INTO kb_fts(kb_fts, rowid, title, content, tags) VALUES ('delete', old.rowid, old.title, old.content, coalesce(old.tags, ''));
	INSERT INTO kb_fts(rowid, title, content, tags) VALUES (new.rowid, new.title, new.content, coalesce(new.tags, ''));
END;
