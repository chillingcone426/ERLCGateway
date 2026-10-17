BEGIN;

CREATE TABLE IF NOT EXISTS rule_jobs (
  id text PRIMARY KEY,
  rule_id text NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
  event_id text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  attempt integer NOT NULL DEFAULT 0,
  state text NOT NULL,
  available_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  last_error_code text,
  UNIQUE(rule_id, event_id)
);

CREATE INDEX IF NOT EXISTS rule_jobs_claim_idx ON rule_jobs(state, available_at);

COMMIT;
