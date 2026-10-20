#!/usr/bin/env python3
"""Deploy tested GitHub branch heads; run from a cron job under the PM2 owner."""

import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request
from pathlib import Path

ROOT = Path("/home/thebeston123/liberty-v2-production")
TOKEN_FILE = ROOT / "shared/github-read-token"
TARGETS = (
    ("chillingcone426/ERLCGateway", "platform-v2", "gateway", "LibertyTools", "http://127.0.0.1:4000/health/ready", False),
    ("Liberty-Tools/LibertyToolsDash", "dashboard-v2-roadmap", "dashboard", "LibertyDash", "http://127.0.0.1:4040/login", True),
)


def request(url, token=None):
    headers = {"Accept": "application/vnd.github+json", "User-Agent": "LibertyTools-release-checker"}
    if token:
        headers["Authorization"] = f"Bearer {token}"
    return urllib.request.Request(url, headers=headers)


def get_json(url, token=None):
    with urllib.request.urlopen(request(url, token), timeout=15) as response:
        return json.load(response)


def tested_head(repo, branch, token):
    sha = get_json(f"https://api.github.com/repos/{repo}/commits/{branch}", token)["sha"]
    if len(sha) != 40 or any(c not in "0123456789abcdef" for c in sha):
        raise RuntimeError("GitHub returned an invalid commit SHA")
    checks = get_json(f"https://api.github.com/repos/{repo}/commits/{sha}/check-runs", token)["check_runs"]
    actions = [run for run in checks if run.get("app", {}).get("slug") == "github-actions"]
    if not actions or any(run.get("status") != "completed" or run.get("conclusion") != "success" for run in actions):
        return sha, False
    return sha, True


def wait_healthy(url):
    for _ in range(30):
        try:
            with urllib.request.urlopen(url, timeout=3) as response:
                if response.status == 200:
                    return
        except Exception:
            pass
        time.sleep(1)
    raise RuntimeError("New release did not pass its health check")


def switch_link(link, target):
    temporary = link.with_name(link.name + ".next")
    if temporary.exists() or temporary.is_symlink():
        temporary.unlink()
    temporary.symlink_to(target, target_is_directory=True)
    os.replace(temporary, link)


def deploy(repo, sha, prefix, service, health_url, token):
    releases = ROOT / "releases"
    release = releases / f"{prefix}-{sha[:7]}"
    link = ROOT / prefix
    previous = link.resolve(strict=True)
    if previous == release:
        return
    if release.exists():
        raise RuntimeError(f"Release {release.name} already exists but is not active")

    with tempfile.TemporaryDirectory(prefix="liberty-deploy-", dir=ROOT / "shared") as workspace:
        archive = Path(workspace) / "source.tar.gz"
        with urllib.request.urlopen(request(f"https://api.github.com/repos/{repo}/tarball/{sha}", token), timeout=60) as response:
            with archive.open("wb") as output:
                shutil.copyfileobj(response, output)
        with tarfile.open(archive, "r:gz") as source:
            members = source.getmembers()
            if not members:
                raise RuntimeError("GitHub archive is empty")
            prefix_name = members[0].name.split("/")[0]
            for member in members:
                parts = Path(member.name).parts
                if (not parts or Path(member.name).is_absolute() or parts[0] != prefix_name
                        or ".." in parts or not (member.isfile() or member.isdir())):
                    raise RuntimeError("GitHub archive contains an unsafe path")
        release.mkdir(mode=0o750)
        try:
            subprocess.run(["tar", "-xzf", str(archive), "--strip-components=1", "-C", str(release), "--no-same-owner"], check=True)
            subprocess.run(["npm", "ci"], cwd=release, check=True)
            subprocess.run(["npm", "run", "check"], cwd=release, check=True)
            switch_link(link, release)
            try:
                subprocess.run(["pm2", "restart", service, "--update-env"], check=True, stdout=subprocess.DEVNULL)
                wait_healthy(health_url)
            except Exception:
                switch_link(link, previous)
                subprocess.run(["pm2", "restart", service, "--update-env"], check=False, stdout=subprocess.DEVNULL)
                raise
            print(f"Deployed {repo} {sha[:7]}")
        except Exception:
            if link.resolve(strict=True) != release:
                shutil.rmtree(release, ignore_errors=True)
            raise


def main():
    dry_run = "--dry-run" in sys.argv
    token = TOKEN_FILE.read_text().strip() if TOKEN_FILE.is_file() else None
    for repo, branch, prefix, service, health_url, private in TARGETS:
        if private and not token:
            if dry_run:
                print(f"{repo}: read-only GitHub token not installed")
            continue
        sha, checks_passed = tested_head(repo, branch, token if private else None)
        current = (ROOT / prefix).resolve(strict=True).name
        if dry_run:
            print(f"{repo}: head={sha[:7]} checks={'passed' if checks_passed else 'pending-or-failed'} current={current}")
        elif checks_passed and current != f"{prefix}-{sha[:7]}":
            deploy(repo, sha, prefix, service, health_url, token if private else None)


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Automatic deployment failed: {error}", file=sys.stderr)
        sys.exit(1)
