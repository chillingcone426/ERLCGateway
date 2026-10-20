# LibertyTools production operations

The gateway and dashboard run from versioned releases under
`/home/thebeston123/liberty-v2-production/releases`. Their `gateway` and
`dashboard` symlinks select the live releases. `auto-deploy.py` polls the
`platform-v2` gateway branch and `dashboard-v2-roadmap` dashboard branch every
five minutes. The public gateway deploys an exact commit only after every
GitHub Actions check for that commit succeeds. The private dashboard uses
GitHub Actions workflow-run status for the same CI gate. Each release runs
`npm ci` and `npm run check` before
the symlink changes. A failed restart or health check restores the previous
symlink and restarts the old release.

The gateway repository is public. The dashboard repository is private and
requires a fine-grained GitHub token scoped only to
`Liberty-Tools/LibertyToolsDash` with **Contents: Read** and **Actions: Read**.
Install it with `python3 shared/install-private-value.py github` in an
interactive SSH session. Never paste the token into a ticket, chat, command
argument, or repository file. It is stored mode 0600 in `shared/github-read-token`.
When the open PRs are merged, change the two branch names in `auto-deploy.py`
to `main` after reviewing the final main-branch commits.

`run-monitor.sh` runs at minutes :02, :07, and every five minutes thereafter.
It reads anonymized ER:LC response samples from
PostgreSQL and checks both public health URLs. Alerts go to an operator Discord
webhook stored mode 0600 in `shared/ops-discord-webhook`; install that URL with
`python3 shared/install-private-value.py discord` at its hidden prompt.
The monitor alerts on recurring API errors, 429 responses, high p95 latency,
low global rate-limit remaining, and service outages. Alerts repeat at most
hourly while a problem persists and send a recovery notice when it clears.
Metrics contain no request bodies, server keys, URLs, player data, or tokens;
they are deleted after seven days.

Use `python3 shared/auto-deploy.py --dry-run` to inspect tested heads without
deploying. Use `node gateway/dist/src/ops-monitor.js --dry-run` with the gateway
database environment to inspect current metrics without sending Discord alerts.
Cron output is in `shared/auto-deploy.log` and `shared/ops-monitor.log`. The
commands are serialized by `flock` to prevent overlapping runs.

For a known outage, post an update in the LibertyTools support Discord linked
from the dashboard. End users should contact LibertyTools, not PRC API support.
If ER:LC is degraded, rates are exhausted, or a key is rejected, stop affected
outbound work and let the provider cooldown expire. If credentials are exposed,
rotate them and notify PRC Support promptly. Report recurring provider
degradation or API security issues to PRC Support through their API Discord or
published security contact, following their current policy.
