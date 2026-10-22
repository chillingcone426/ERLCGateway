BEGIN;

ALTER TABLE rule_jobs ADD COLUMN IF NOT EXISTS revision integer;

COMMIT;
