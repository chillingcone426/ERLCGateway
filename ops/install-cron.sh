#!/usr/bin/env bash
set -euo pipefail
root=/home/thebeston123/liberty-v2-production/shared
existing="$(crontab -l 2>/dev/null || true)"
if [[ "$existing" == *"# libertytools-ops-begin"* ]]; then
  echo "LibertyTools operations schedule is already installed"
  exit 0
fi
{
  if [[ -n "$existing" ]]; then printf '%s\n' "$existing"; fi
  cat <<'CRON'
# libertytools-ops-begin
*/5 * * * * /usr/bin/flock -n /home/thebeston123/liberty-v2-production/shared/auto-deploy.lock /usr/bin/python3 /home/thebeston123/liberty-v2-production/shared/auto-deploy.py >> /home/thebeston123/liberty-v2-production/shared/auto-deploy.log 2>&1
2-59/5 * * * * /usr/bin/flock -n /home/thebeston123/liberty-v2-production/shared/ops-monitor.lock /bin/bash /home/thebeston123/liberty-v2-production/shared/run-monitor.sh >> /home/thebeston123/liberty-v2-production/shared/ops-monitor.log 2>&1
# libertytools-ops-end
CRON
} | crontab -
echo "LibertyTools operations schedule installed"
