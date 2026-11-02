#!/usr/bin/env bash
# Deployment of the test environment (started by stunden-test-deploy.timer, see deploy/bootstrap-test.sh).
# Only the commit in /etc/stunden-test/approved-commit (root-owned, set with `stunden-test-freigeben <commit>`)
# is ever deployed. A newer commit on the branch stunden-test-deploy is only reported in the status, never run.
# When the approved commit is not running yet:
#   update-test.sh (backup if a DB exists, build, migrate, restart, health check),
#   test accounts once  → /root/stundenwerk-testzugaenge.txt (mode 600, never in the journal),
#   backup + restore test (deploy/sicherung.sh, also daily via stunden-test-backup.timer).
# After 3 failed attempts with the same commit it stops retrying until a new commit is approved.
# Result lines (no secrets) go to the journal and /var/lib/stunden-test/status.txt.
set -euo pipefail

# The whole script is one function so that bash has parsed it completely before update-test.sh
# checks out a new version of this file.
main() {
BRANCH="stunden-test-deploy"
STATE=/var/lib/stunden-test
ACCOUNTS=/root/stundenwerk-testzugaenge.txt
APPROVED_FILE=/etc/stunden-test/approved-commit
cd "$(dirname "$0")/.."
mkdir -p "$STATE"
# One job at a time: the daily backup (stunden-test-backup.service) takes the same lock.
exec 9>/run/stunden-test.lock
flock 9
status() { printf '%s %s\n' "$(date -Is)" "$*" | tee -a "$STATE/status.txt"; }

TARGET="$({ tr -d '[:space:]' < "$APPROVED_FILE"; } 2>/dev/null || true)"
[[ "$TARGET" =~ ^[0-9a-f]{40}$ ]] || { echo "Kein gültiger freigegebener Commit in $APPROVED_FILE – nichts zu tun."; exit 0; }
git fetch --quiet origin
HEAD_BRANCH="$(git rev-parse "origin/$BRANCH" 2>/dev/null || true)"
if [ -n "$HEAD_BRANCH" ] && [ "$HEAD_BRANCH" != "$TARGET" ] && [ "$(cat "$STATE/announced" 2>/dev/null || true)" != "$HEAD_BRANCH" ]; then
  echo "$HEAD_BRANCH" > "$STATE/announced"
  status "Hinweis: Stand ${HEAD_BRANCH:0:12} auf $BRANCH ist nicht freigegeben (prüfen, dann: stunden-test-freigeben $HEAD_BRANCH)"
fi

DEPLOYED="$(cat "$STATE/deployed-commit" 2>/dev/null || true)"
if [ "$TARGET" = "$DEPLOYED" ] && [ "$(docker inspect --type container -f '{{.State.Health.Status}}' stunden-test-app 2>/dev/null || true)" = healthy ]; then
  exit 0
fi
FAILS="$(cat "$STATE/failed-$TARGET" 2>/dev/null || true)"
[[ "$FAILS" =~ ^[0-9]+$ ]] || FAILS=0
if [ "$FAILS" -ge 3 ]; then
  echo "Commit ${TARGET:0:12} ist 3-mal gescheitert – keine weiteren Versuche bis zur nächsten Freigabe."
  exit 0
fi
git cat-file -e "$TARGET^{commit}" 2>/dev/null || { status "FEHLER: freigegebener Commit ${TARGET:0:12} nicht im Repository"; exit 1; }

status "Bereitstellung ${TARGET:0:12} beginnt"

# Check out exactly the approved commit before running anything from it; update-test.sh does the same again.
# update-test.sh must not seed (its seed prints passwords to the journal).
if ! { git -c advice.detachedHead=false checkout --quiet --detach "$TARGET^{commit}" \
       && [ "$(git rev-parse HEAD)" = "$TARGET" ] && bash deploy/update-test.sh "$TARGET"; }; then
  echo $((FAILS + 1)) > "$STATE/failed-$TARGET"
  status "FEHLER: update-test.sh fehlgeschlagen, Versuch $((FAILS + 1))/3 (journalctl -u stunden-test-deploy)"
  exit 1
fi
[ "$(git rev-parse HEAD)" = "$TARGET" ] || { status "FEHLER: ausgecheckter Stand ist nicht ${TARGET:0:12}"; exit 1; }
rm -f "$STATE"/failed-*
echo "$TARGET" > "$STATE/deployed-commit"
status "OK: App läuft mit ${TARGET:0:12}"

C=(docker compose -f deploy/docker-compose.yml --env-file deploy/.env)
if [ ! -s "$ACCOUNTS" ] && [ ! -e "$STATE/seeded" ]; then
  ( umask 077
    if "${C[@]}" run --rm -T migrate node --experimental-strip-types --disable-warning=ExperimentalWarning \
        --import ./server/register.mjs server/src/cli.ts seed-test-env --confirm-test-environment \
        --domain=stunden-test.example > "$ACCOUNTS.tmp" 2> "$STATE/seed.log"; then
      mv "$ACCOUNTS.tmp" "$ACCOUNTS"; touch "$STATE/seeded"; status "OK: Testzugänge angelegt ($ACCOUNTS, nur root)"
    else
      status "FEHLER: Testzugänge nicht angelegt (Details in $STATE/seed.log, nächster Versuch bei der nächsten Bereitstellung)"
    fi )
fi

# Backup and restore test (never touches the running database): deploy/sicherung.sh, also run daily by
# stunden-test-backup.timer (deploy/taegliche-sicherung-einrichten.sh).
bash deploy/sicherung.sh || true
}
main "$@"
exit
