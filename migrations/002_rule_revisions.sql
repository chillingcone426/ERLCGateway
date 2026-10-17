BEGIN;

CREATE TABLE IF NOT EXISTS rule_revisions (
  rule_id text NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
  revision integer NOT NULL,
  definition jsonb NOT NULL,
  published_at timestamptz NOT NULL,
  PRIMARY KEY(rule_id, revision)
);

CREATE INDEX IF NOT EXISTS delivery_attempts_delivery_idx
  ON delivery_attempts(delivery_id, attempted_at);

COMMIT;
