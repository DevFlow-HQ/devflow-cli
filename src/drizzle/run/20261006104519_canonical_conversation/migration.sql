-- The old transcript is authoritative, even when its assistant text differs
-- from retained events or result copies. Drizzle runs this whole journal entry
-- and its journal acknowledgement in one transaction.
ALTER TABLE `turn_event` ADD `transcript_seq` integer;
--> statement-breakpoint
CREATE UNIQUE INDEX `turn_event_transcript_seq_unique` ON `turn_event` (`transcript_seq`);
--> statement-breakpoint
CREATE TABLE `conversation_migration_guard` (`valid` integer NOT NULL);
--> statement-breakpoint
CREATE TRIGGER `conversation_orphan_guard` BEFORE INSERT ON `conversation_migration_guard`
WHEN NEW.valid = 0 BEGIN SELECT RAISE(ABORT, 'conversation migration: orphan Turn or Session association'); END;
--> statement-breakpoint
INSERT INTO `conversation_migration_guard` SELECT NOT EXISTS (
  SELECT 1 FROM `transcript_entry` AS old
  LEFT JOIN `turn` AS t ON t.turn_id = old.turn_id
  LEFT JOIN `harness_session` AS s ON s.session_key = old.session_key
  WHERE t.turn_id IS NULL OR s.session_key IS NULL OR t.session_key != old.session_key
);
--> statement-breakpoint
DROP TRIGGER `conversation_orphan_guard`;
--> statement-breakpoint
INSERT INTO `turn_event` (`turn_id`, `kind`, `payload`, `at`, `transcript_seq`)
SELECT turn_id, 'legacy-message', json_object('role', role, 'content', content), at, seq
FROM `transcript_entry` ORDER BY seq;
--> statement-breakpoint
CREATE TRIGGER `conversation_copy_guard` BEFORE INSERT ON `conversation_migration_guard`
WHEN NEW.valid = 0 BEGIN SELECT RAISE(ABORT, 'conversation migration: count/order/content/association mismatch'); END;
--> statement-breakpoint
INSERT INTO `conversation_migration_guard` SELECT
  (SELECT count(*) FROM `transcript_entry`) = (SELECT count(*) FROM `turn_event` WHERE transcript_seq IS NOT NULL)
  AND NOT EXISTS (
    SELECT old.seq, old.session_key, old.turn_id, old.role, old.content, old.at FROM `transcript_entry` AS old
    EXCEPT
    SELECT e.transcript_seq, t.session_key, e.turn_id, json_extract(e.payload, '$.role'), json_extract(e.payload, '$.content'), e.at
    FROM `turn_event` AS e JOIN `turn` AS t ON t.turn_id = e.turn_id WHERE e.transcript_seq IS NOT NULL
  );
--> statement-breakpoint
DROP TABLE `conversation_migration_guard`;
--> statement-breakpoint
DROP TABLE `transcript_entry`;
