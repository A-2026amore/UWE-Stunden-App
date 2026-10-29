#!/usr/bin/env bash
# Deployment of the test environment (started by stunden-test-deploy.timer, see deploy/bootstrap-test.sh).
# Only the commit in /etc/stunden-test/approved-commit (root-owned, set with `stunden-test-freigeben <commit>`)
# is ever deployed. A newer commit on the branch stunden-test-deploy is only reported in the status, never run.
# When the approved commit is not running yet:
#   update-test.sh (backup if a DB exists, build, migrate, restart, health check),
#   test accounts once  → /root/stundenwerk-testzugaenge.txt (mode 600, never in the journal),
#   backup + restore test (deploy/backup.sh, deploy/restore-test.sh --docker); with /root/.stunden-test-restic.env
#   the archive also goes to the Hetzner Storage Box (restic) and the restore test uses the copy fetched back from there.
# After 3 failed attempts with the same commit it stops retrying until a new commit is approved.
# Result lines (no secrets) go to the journal and /var/lib/stunden-test/status.txt.
set -euo pipefail

# The whole script is one function so that bash has parsed it completely before update-test.sh
# checks out a new version of this file.
main() {
BRANCH="stunden-test-deploy"
STATE=/var/lib/stunden-test
ACCOUNTS=/root/stundenwerk-testzugaenge.txt
RESTIC_ENV=/root/.stunden-test-restic.env
APPROVED_FILE=/etc/stunden-test/approved-commit
cd "$(dirname "$0")/.."
mkdir -p "$STATE"
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
if [ "$TARGET" = "$DEPLOYED" ] && [ "$(docker inspect -f '{{.State.Health.Status}}' stunden-test-app 2>/dev/null || true)" = healthy ]; then
  exit 0
fi
FAILS="$(cat "$STATE/failed-$TARGET" 2>/dev/null || echo 0)"
if [ "$FAILS" -ge 3 ]; then
  echo "Commit ${TARGET:0:12} ist 3-mal gescheitert – keine weiteren Versuche bis zur nächsten Freigabe."
  exit 0
fi
git cat-file -e "$TARGET^{commit}" 2>/dev/null || { status "FEHLER: freigegebener Commit ${TARGET:0:12} nicht im Repository"; exit 1; }

status "Bereitstellung ${TARGET:0:12} beginnt"

# update-test.sh checks out exactly this commit (detached); it must not seed (its seed prints passwords to the journal).
if ! bash deploy/update-test.sh "$TARGET"; then
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
        --domain=stunden-test.example > "$ACCOUNTS.tmp" 2>&1; then
      mv "$ACCOUNTS.tmp" "$ACCOUNTS"; touch "$STATE/seeded"; status "OK: Testzugänge angelegt ($ACCOUNTS, nur root)"
    else
      status "FEHLER: Testzugänge nicht angelegt (Details in $ACCOUNTS.tmp, nächster Versuch bei der nächsten Bereitstellung)"
    fi )
fi

# Backup and restore test (never touches the running database).
HOOK=""
if [ -f "$RESTIC_ENV" ]; then
  # shellcheck disable=SC1090
  set -a; . "$RESTIC_ENV"; set +a
  HOOK='restic backup --quiet --tag stunden --tag "$STAGE" "$@"'
fi
BDIR=/var/backups/stunden-test
if BACKUP_DIR="$BDIR" BACKUP_HOOK="$HOOK" BACKUP_STATUS_FILE="$STATE/last-backup" deploy/backup.sh --compose deploy/.env > "$STATE/backup.log" 2>&1; then
  ARCHIVE="$(ls -t "$BDIR"/*.tar.gpg | head -n1)"
  SOURCE="lokal"
  if [ -n "$HOOK" ]; then
    FETCH="$(mktemp -d)"
    if restic restore latest --tag stunden --target "$FETCH" --include "$ARCHIVE" --include "$ARCHIVE.sha256" >/dev/null 2>&1 \
       && [ -f "$FETCH$ARCHIVE" ]; then
      ARCHIVE="$FETCH$ARCHIVE"; SOURCE="Hetzner Storage Box (restic)"
    else
      status "FEHLER: Abruf aus der Storage Box fehlgeschlagen – Wiederherstellungsprobe mit lokaler Kopie"
    fi
  fi
  if deploy/restore-test.sh --docker --migrations db/migrations "$ARCHIVE" > "$STATE/restore.log" 2>&1; then
    status "OK: Sicherung + Wiederherstellungsprobe bestanden (Quelle: $SOURCE)"
  else
    status "FEHLER: Wiederherstellungsprobe fehlgeschlagen ($STATE/restore.log)"
  fi
else
  status "FEHLER: Sicherung fehlgeschlagen ($STATE/backup.log)"
fi
[ -z "${FETCH:-}" ] || rm -rf "$FETCH"
[ -n "$HOOK" ] || status "Hinweis: Storage Box nicht eingebunden ($RESTIC_ENV fehlt) – Sicherung nur lokal in $BDIR"
}
main "$@"
exit
