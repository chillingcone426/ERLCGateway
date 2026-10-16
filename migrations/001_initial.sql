BEGIN;

CREATE TABLE IF NOT EXISTS connections (
  id text PRIMARY KEY,
  account_id text NOT NULL,
  name text NOT NULL,
  public_id text NOT NULL UNIQUE,
  paused boolean NOT NULL DEFAULT false,
  legacy_preset text,
  server_id text,
  server_name text,
  encrypted_server_key text,
  server_key_fingerprint text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz
);
CREATE INDEX IF NOT EXISTS connections_account_idx ON connections(account_id) WHERE deleted_at IS NULL;

CREATE TABLE IF NOT EXISTS poll_subscriptions (
  id text PRIMARY KEY,
  connection_id text NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  name text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  token_prefix text NOT NULL,
  event_types jsonb NOT NULL DEFAULT '[]',
  included_commands jsonb NOT NULL DEFAULT '[]',
  excluded_commands jsonb NOT NULL DEFAULT '[]',
  created_at timestamptz NOT NULL,
  last_used_at timestamptz,
  revoked_at timestamptz
);

CREATE TABLE IF NOT EXISTS forward_destinations (
  id text PRIMARY KEY,
  connection_id text NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  name text NOT NULL,
  type text NOT NULL,
  url text NOT NULL,
  provider_preset text,
  encrypted_secret text,
  secret_prefix text,
  health_state text NOT NULL,
  enabled boolean NOT NULL,
  transport_security text NOT NULL,
  consecutive_failures integer NOT NULL DEFAULT 0,
  successful_deliveries integer NOT NULL DEFAULT 0,
  filter jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS events (
  id text PRIMARY KEY,
  connection_id text NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  type text NOT NULL,
  original_type text,
  occurred_at timestamptz NOT NULL,
  received_at timestamptz NOT NULL,
  server_id text,
  data jsonb NOT NULL,
  raw_body bytea NOT NULL,
  original_headers jsonb NOT NULL,
  synthetic boolean NOT NULL DEFAULT false,
  dedupe_key text NOT NULL,
  UNIQUE(connection_id, dedupe_key)
);
CREATE INDEX IF NOT EXISTS events_connection_cursor_idx ON events(connection_id, received_at, id);

CREATE TABLE IF NOT EXISTS poll_acknowledgements (
  subscription_id text NOT NULL REFERENCES poll_subscriptions(id) ON DELETE CASCADE,
  event_id text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  acknowledged_at timestamptz NOT NULL,
  PRIMARY KEY(subscription_id, event_id)
);

CREATE TABLE IF NOT EXISTS delivery_jobs (
  id text PRIMARY KEY,
  destination_id text NOT NULL REFERENCES forward_destinations(id) ON DELETE CASCADE,
  event_id text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  attempt integer NOT NULL DEFAULT 0,
  state text NOT NULL,
  available_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  last_error_code text,
  UNIQUE(destination_id, event_id)
);
CREATE INDEX IF NOT EXISTS delivery_jobs_claim_idx ON delivery_jobs(state, available_at);

CREATE TABLE IF NOT EXISTS delivery_attempts (
  id text PRIMARY KEY,
  delivery_id text NOT NULL REFERENCES delivery_jobs(id) ON DELETE CASCADE,
  attempted_at timestamptz NOT NULL,
  status_code integer,
  latency_ms integer NOT NULL,
  result text NOT NULL,
  response_excerpt text,
  error_code text
);

CREATE TABLE IF NOT EXISTS rules (
  id text PRIMARY KEY,
  connection_id text NOT NULL REFERENCES connections(id) ON DELETE CASCADE,
  name text NOT NULL,
  enabled boolean NOT NULL DEFAULT false,
  draft_version integer NOT NULL DEFAULT 1,
  draft jsonb NOT NULL,
  active_revision integer,
  published jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS rule_executions (
  id text PRIMARY KEY,
  rule_id text NOT NULL REFERENCES rules(id) ON DELETE CASCADE,
  event_id text NOT NULL REFERENCES events(id) ON DELETE CASCADE,
  status text NOT NULL,
  detail jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  completed_at timestamptz
);

CREATE TABLE IF NOT EXISTS rate_limits (
  key text PRIMARY KEY,
  count integer NOT NULL,
  reset_at timestamptz NOT NULL
);

CREATE TABLE IF NOT EXISTS cooldowns (
  key text PRIMARY KEY,
  available_at timestamptz NOT NULL
);

COMMIT;
