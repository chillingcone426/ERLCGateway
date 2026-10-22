BEGIN;

CREATE TABLE IF NOT EXISTS provider_requests (
  id bigserial PRIMARY KEY,
  operation text NOT NULL CHECK (operation IN ('server', 'players', 'command')),
  status_code integer,
  latency_ms integer NOT NULL CHECK (latency_ms >= 0),
  rate_limit_bucket text,
  rate_limit_limit integer,
  rate_limit_remaining integer,
  recorded_at timestamptz NOT NULL
);

CREATE INDEX IF NOT EXISTS provider_requests_recorded_at_idx ON provider_requests(recorded_at DESC);

COMMIT;
