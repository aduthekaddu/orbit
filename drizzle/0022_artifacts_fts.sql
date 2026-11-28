CREATE VIRTUAL TABLE artifacts_fts USING fts5(
	derived_title,
	user_title,
	code,
	content='artifacts',
	content_rowid='seq'
);
--> statement-breakpoint
CREATE TRIGGER artifacts_fts_ai AFTER INSERT ON artifacts BEGIN
	INSERT INTO artifacts_fts(rowid, derived_title, user_title, code)
	VALUES (new.seq, new.derived_title, new.user_title, new.code);
END;
--> statement-breakpoint
CREATE TRIGGER artifacts_fts_ad AFTER DELETE ON artifacts BEGIN
	INSERT INTO artifacts_fts(artifacts_fts, rowid, derived_title, user_title, code)
	VALUES ('delete', old.seq, old.derived_title, old.user_title, old.code);
END;
--> statement-breakpoint
CREATE TRIGGER artifacts_fts_au AFTER UPDATE OF derived_title, user_title, code ON artifacts BEGIN
	INSERT INTO artifacts_fts(artifacts_fts, rowid, derived_title, user_title, code)
	VALUES ('delete', old.seq, old.derived_title, old.user_title, old.code);
	INSERT INTO artifacts_fts(rowid, derived_title, user_title, code)
	VALUES (new.seq, new.derived_title, new.user_title, new.code);
END;
--> statement-breakpoint
INSERT INTO artifacts_fts(artifacts_fts) VALUES ('rebuild');
