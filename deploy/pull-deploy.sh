#!/usr/bin/env bash
# Pull-based deployment of the test environment (started by stunden-test-deploy.timer, see deploy/bootstrap-test.sh).
# The server fetches the branch stunden-test-deploy (read-only, public repository). Only when its commit changed:
#   update-test.sh (backup if a DB exists, build, migrate, restart, health check),
#   test accounts once  → /root/stundenwerk-testzugaenge.txt (mode 600, never in the journal),
#   backup + restore test (deploy/backup.sh, deploy/restore-test.sh --docker); with /root/.stunden-test-restic.env
#   the archive also goes to the Hetzner Storage Box (restic) and the restore test uses the copy fetched back from there.
# Result lines (no secrets) go to the journal and /var/lib/stunden-test/status.txt.
set -euo pipefail

# The whole script is one function so that bash has parsed it completely before update-test.sh
# checks out a new version of this file.
main() {
BRANCH="stunden-test-deploy"
STATE=/var/lib/stunden-test
ACCOUNTS=/root/stundenwerk-testzugaenge.txt
RESTIC_ENV=/root/.stunden-test-restic.env
cd "$(dirname "$0")/.."
mkdir -p "$STATE"

git fetch --quiet origin "$BRANCH"
TARGET="$(git rev-parse "origin/$BRANCH")"
DEPLOYED="$(cat "$STATE/deployed-commit" 2>/dev/null || true)"
if [ "$TARGET" = "$DEPLOYED" ] && [ "$(docker inspect -f '{{.State.Health.Status}}' stunden-test-app 2>/dev/null || true)" = healthy ]; then
  exit 0
fi

status() { printf '%s %s\n' "$(date -Is)" "$*" | tee -a "$STATE/status.txt"; }
status "Bereitstellung ${TARGET:0:12} beginnt"

# update-test.sh checks out the branch itself; it must not seed (its seed prints passwords to the console/journal).
if ! bash deploy/update-test.sh "$BRANCH"; then
  status "FEHLER: update-test.sh fehlgeschlagen (journalctl -u stunden-test-deploy)"
  exit 1
fi
echo "$TARGET" > "$STATE/deployed-commit"
status "OK: App läuft mit ${TARGET:0:12}"

C=(docker compose -f deploy/docker-compose.yml --env-file deploy/.env)
if [ ! -s "$ACCOUNTS" ] && [ ! -e "$STATE/seeded" ]; then
  ( umask 077
    if "${C[@]}" run --rm -T migrate node --experimental-strip-types --disable-warning=ExperimentalWarning \
        --import ./server/register.mjs server/src/cli.ts seed-test-env --confirm-test-environment \
        --domain=stunden-test.example > "$ACCOUNTS" 2>&1; then
      touch "$STATE/seeded"; status "OK: Testzugänge angelegt ($ACCOUNTS, nur root)"
    else
      status "FEHLER: Testzugänge nicht angelegt (Details in $ACCOUNTS)"
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
