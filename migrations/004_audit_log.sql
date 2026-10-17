BEGIN;

CREATE TABLE IF NOT EXISTS audit_log (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  connection_id text,
  action text NOT NULL,
  request_id text NOT NULL,
  status_code integer NOT NULL,
  created_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS audit_log_account_created_idx ON audit_log(account_id, created_at DESC);

COMMIT;
