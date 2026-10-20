# Liberty Tools Gateway

The v2 gateway accepts one signed ER:LC webhook per connection and fans each event out to independent Poll clients, hosted command rules, signed Proxy destinations, and raw mirrors.

## Local setup

1. Create a PostgreSQL database.
2. Copy `.env.example` to `.env` and set `DATABASE_URL`, `MANAGEMENT_API_TOKEN`, `SECRET_ENCRYPTION_KEY_BASE64`, and the public application's `ERLC_GLOBAL_API_KEY`.
3. Run `npm ci`, then `npm run dev`.

Migrations in `migrations/` run in filename order when the service starts. The service exposes `/health/live` and `/health/ready`.

## Security model

- Incoming events must carry a valid ER:LC Ed25519 signature over the exact timestamp and raw request bytes.
- Destination URLs may use HTTP or HTTPS, including public IP addresses. Loopback, private, link-local, metadata, and internal DNS results are blocked. Redirects are not followed.
- Signed Proxy requests include `x-liberty-timestamp` and `x-liberty-signature`. Raw Mirror requests preserve the original ER:LC body and signature headers.
- New destinations begin in probation. Any successful 2xx response activates them. Five consecutive probation failures or ten consecutive established failures pause delivery.
- Hosted actions require an encrypted ER:LC server key and run through a durable worker with cooldown and account budgets.
- Every outbound ER:LC request sends the server's key in `Server-Key` and the public application's global key in `Authorization`. No outbound ER:LC request runs when the global key is missing. Keep the global key only in the private gateway environment file, never in the dashboard, SDK, repository, or logs.
- ER:LC command requests share an application-wide cooldown. Any 429 pauses outbound requests for the provider's full `Retry-After` period; global-key authentication failures pause requests for an hour to avoid repeated invalid calls. A rejected global key never clears a user's server key.
- Server owners may need to approve hosted commands through an ER:LC authorization link. The dashboard builds that link from the non-secret App ID and the server's Internal Server ID.

## Main API flow

The dashboard sends `Authorization: Bearer <MANAGEMENT_API_TOKEN>` and an account identity in `x-liberty-account-id` to management endpoints.

1. `POST /v1/management/connections`
2. Put the returned `ingestUrl` in ER:LC.
3. Add any combination of Poll subscriptions, destinations, and hosted rules below that connection.
4. Poll consumers use the one-time token at `/v1/poll/subscriptions/:id/events` and acknowledge completed event IDs.

Run `npm run check` for the TypeScript build and test suite.

## Migrating the old MongoDB service

The migration command reads the old `webhooks` and optional `webhookEvents`
collections and writes equivalent v2 records to PostgreSQL. It never updates or
deletes MongoDB data, keeps every existing `webhookId`, and is idempotent.

Old Poll webhooks receive an internal legacy Poll subscription, old Proxy
webhooks become exact-byte raw mirrors, and old Easy webhooks keep their original
flattened JSON delivery format through a migration-only destination type. New
destinations continue to use signed Proxy or raw mirror formats.

```bash
# Inspect the plan. This is the default and does not write PostgreSQL.
MONGO_URI=mongodb://127.0.0.1:27017 \
MONGO_DB_NAME=erlc_gateway \
npm run migrate:mongodb -- --report migration-dry-run.json

# Apply after reviewing the dry-run report. Queued events are optional.
MONGO_URI=mongodb://127.0.0.1:27017 \
MONGO_DB_NAME=erlc_gateway \
DATABASE_URL=postgres://libertytools:libertytools@localhost:5432/libertytools \
npm run migrate:mongodb -- --apply --include-events --report migration-applied.json
```

Reports are created with exclusive-write semantics so an existing report cannot
be overwritten. Blocked, private, malformed, or missing destination URLs do not
prevent the connection and stable webhook ID from being migrated; the report
marks those connections for manual destination repair. Imported queued events
are stored for Poll retrieval and are not forwarded again.
