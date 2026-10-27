#!/usr/bin/env bash
# AppZentrale24 - verschlüsselte Sicherung aller Anwendungen (restic, AES-256)
#
# 1. Sichert jede PostgreSQL-Datenbank, deren Container das Label
#    de.appzentrale24.backup=postgres trägt, per pg_dumpall.
# 2. Sichert /srv/appzentrale24 (Konfiguration, Uploads, Zertifikate) und die Dumps
#    verschlüsselt in das restic-Repository (externer Speicher).
# 3. Löscht alte Stände (14 täglich, 8 wöchentlich, 12 monatlich) und prüft das Repository.
#
# Zugangsdaten stehen in /etc/appzentrale24/backup.env (nur root lesbar), siehe backup.env.example.
set -euo pipefail

ENV_FILE=/etc/appzentrale24/backup.env
DUMP_DIR=/var/backups/appzentrale24/dumps
SRC=/srv/appzentrale24

[ -r "$ENV_FILE" ] || { echo "Fehlt: $ENV_FILE" >&2; exit 1; }
set -a; . "$ENV_FILE"; set +a

umask 077
mkdir -p "$DUMP_DIR"
rm -f "$DUMP_DIR"/*.sql.gz

for c in $(docker ps --filter label=de.appzentrale24.backup=postgres --format '{{.Names}}'); do
  echo ">> Datenbank-Dump $c"
  docker exec "$c" sh -c 'pg_dumpall -U "$POSTGRES_USER"' | gzip -6 >"$DUMP_DIR/$c.sql.gz"
  # Ein leerer Dump bedeutet einen Fehler - lieber laut abbrechen als still eine leere Sicherung behalten
  [ "$(gzip -dc "$DUMP_DIR/$c.sql.gz" | head -c 100 | wc -c)" -gt 0 ] || { echo "Dump leer: $c" >&2; exit 1; }
done

echo ">> restic backup"
restic backup --tag nightly --one-file-system \
  --exclude "$SRC/*/node_modules" \
  "$SRC" "$DUMP_DIR"

echo ">> Aufräumen"
restic forget --tag nightly --keep-daily 14 --keep-weekly 8 --keep-monthly 12 --prune

echo ">> Prüfung"
restic check --read-data-subset=2%

echo "Sicherung erfolgreich: $(date -Is)"
