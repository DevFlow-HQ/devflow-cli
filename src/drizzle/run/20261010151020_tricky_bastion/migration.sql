CREATE TABLE `failure_evidence` (
	`evidence_id` text PRIMARY KEY,
	`attempt_id` text NOT NULL,
	`turn_id` text,
	`source` text NOT NULL,
	`code` text NOT NULL,
	`phase` text,
	`category` text,
	`possible_effects` text NOT NULL,
	`native_code` text,
	`details` text,
	`diagnostic_id` text,
	`at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `failure_evidence_turn` ON `failure_evidence` (`turn_id`) WHERE "failure_evidence"."turn_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX `failure_evidence_attempt` ON `failure_evidence` (`attempt_id`) WHERE "failure_evidence"."turn_id" IS NULL;