DROP TRIGGER IF EXISTS user_single_row;
--> statement-breakpoint
CREATE TABLE __tmp_memories_vec (
  rowid integer PRIMARY KEY NOT NULL,
  user_id text NOT NULL,
  embedding blob NOT NULL
);
--> statement-breakpoint
INSERT INTO __tmp_memories_vec(rowid, user_id, embedding)
SELECT v.rowid, m.user_id, v.embedding FROM memories_vec v JOIN memories m ON m.seq = v.rowid;
--> statement-breakpoint
DROP TABLE memories_vec;
--> statement-breakpoint
CREATE VIRTUAL TABLE memories_vec USING vec0(user_id text partition key, embedding float[768]);
--> statement-breakpoint
INSERT INTO memories_vec(rowid, user_id, embedding)
SELECT rowid, user_id, embedding FROM __tmp_memories_vec;
--> statement-breakpoint
DROP TABLE __tmp_memories_vec;
--> statement-breakpoint
CREATE TRIGGER memories_vec_ad AFTER DELETE ON memories BEGIN
  DELETE FROM memories_vec WHERE rowid = old.seq;
END;
