#!/usr/bin/env bash
# Backup and restore probe of one environment (STAGE=test, default, or STAGE=prod). Started by deploy/pull-deploy.sh after every deployment and
# daily by stunden-test-backup.timer (installed once with deploy/taegliche-sicherung-einrichten.sh).
#   1. deploy/backup.sh: encrypted dump of the running database (never changes it), local copies: the last 14,
#   2. with /root/.stunden-test-restic.env (deploy/storagebox-einrichten.sh) the archive also goes to the Hetzner
#      Storage Box (restic) and is fetched back from there,
#   3. deploy/restore-test.sh --docker: the archive is restored into a throwaway database and checked.
# Nothing is ever deleted on the Storage Box. Result lines (no secrets) go to the journal and
# /var/lib/stunden-test/status.txt; exit code 1 when the backup or the restore probe failed.
set -euo pipefail

main() {
STAGE="${STAGE:-test}"
[[ "$STAGE" =~ ^(test|prod)$ ]] || { echo "STAGE muss test oder prod sein." >&2; exit 2; }
STATE="${STATE_DIR:-/var/lib/stunden-$STAGE}"
RESTIC_ENV="${RESTIC_ENV:-/root/.stunden-$STAGE-restic.env}"
BDIR="${BACKUP_DIR:-/var/backups/stunden-$STAGE}"
cd "$(dirname "$0")/.."
mkdir -p "$STATE"
status() { printf '%s %s\n' "$(date -Is)" "$*" | tee -a "$STATE/status.txt"; }

HOOK=""
if [ -f "$RESTIC_ENV" ] && [ "$(stat -c '%u %a' "$RESTIC_ENV")" != "0 600" ]; then
  status "FEHLER: $RESTIC_ENV muss root gehören und Rechte 600 haben – Storage Box wird nicht genutzt"
elif [ -f "$RESTIC_ENV" ]; then
  # shellcheck disable=SC1090
  set -a; . "$RESTIC_ENV"; set +a
  # shellcheck disable=SC2016 # expanded later by backup.sh
  HOOK='restic backup --quiet --tag stunden --tag "$STAGE" "$@"'
fi
FETCH=""
trap '[ -z "$FETCH" ] || rm -rf "$FETCH"' EXIT
RC=0
if BACKUP_DIR="$BDIR" BACKUP_HOOK="$HOOK" BACKUP_STATUS_FILE="$STATE/last-backup" deploy/backup.sh --compose deploy/.env > "$STATE/backup.log" 2>&1; then
  # shellcheck disable=SC2012
  ARCHIVE="$(ls -t "$BDIR"/*.tar.gpg | head -n1)"
  SOURCE="lokal"
  if [ -n "$HOOK" ]; then
    FETCH="$(mktemp -d)"
    if restic restore latest --tag "stunden,$STAGE" --target "$FETCH" --include "$ARCHIVE" --include "$ARCHIVE.sha256" >/dev/null 2>&1 \
       && [ -f "$FETCH$ARCHIVE" ]; then
      ARCHIVE="$FETCH$ARCHIVE"; SOURCE="Hetzner Storage Box (restic)"
    else
      status "FEHLER: Abruf aus der Storage Box fehlgeschlagen – Wiederherstellungsprobe mit lokaler Kopie"; RC=1
    fi
  fi
  if deploy/restore-test.sh --docker --migrations db/migrations "$ARCHIVE" > "$STATE/restore.log" 2>&1; then
    status "OK: Sicherung + Wiederherstellungsprobe bestanden (Quelle: $SOURCE)"
  else
    status "FEHLER: Wiederherstellungsprobe fehlgeschlagen ($STATE/restore.log)"; RC=1
  fi
else
  status "FEHLER: Sicherung fehlgeschlagen ($STATE/backup.log)"; RC=1
fi
[ -n "$HOOK" ] || status "Hinweis: Storage Box nicht eingebunden ($RESTIC_ENV fehlt) – Sicherung nur lokal in $BDIR"
return "$RC"
}
main "$@"
exit
