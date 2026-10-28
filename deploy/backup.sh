#!/usr/bin/env bash
# Verschlüsseltes Datenbank-Backup der Zeiterfassung (Anleitung: docs/betrieb.md, Abschnitt 5).
#
#   deploy/backup.sh [--compose ENV_FILE | --url POSTGRES_URL] [--out DIR]
#
# Ergebnis (ein Satz je Lauf, nur verschlüsselt auf der Platte):
#   stunden-<STAGE>-<UTC-Zeit>.tar.gpg          verschlüsseltes Archiv mit
#       database.dump   pg_dump im Custom-Format (pg_restore-fähig)
#       roles.sql       pg_dumpall --roles-only --no-role-passwords (Rollen, Mitgliedschaften; keine Passwörter)
#       manifest.txt    Zeitpunkt, Versionen, Zeilenzahlen (für die Prüfung beim Wiederherstellen)
#       migrations.tsv  eingespielte Migrationen (Name, SHA-256) aus ops.schema_migrations
#   stunden-<STAGE>-<UTC-Zeit>.tar.gpg.sha256   Prüfsumme (sha256sum -c)
#
# Dump und Zählung stammen aus demselben Datenbank-Schnappschuss (pg_export_snapshot), damit die
# Zahlen im Manifest exakt zum Dump passen.
#
# Quelle:
#   --compose ENV_FILE  (Standard: deploy/.env) Container "db" der Compose-Umgebung; pg_dump läuft im
#                       Container als POSTGRES_USER (lokaler Socket). Docker Compose muss verfügbar sein.
#   --url URL           Direkte Verbindung als Eigentümer/Superuser (z. B. Tests, CI). Lokale pg_dump-Version
#                       muss ≥ Server-Version sein.
#
# Verschlüsselung (Pflicht – ohne eine der beiden Angaben bricht das Skript ab):
#   BACKUP_GPG_RECIPIENT    Schlüssel-ID/Fingerabdruck eines öffentlichen GPG-Schlüssels (empfohlen: der
#                           private Schlüssel liegt NICHT auf dem Server, sondern offline beim Inhaber).
#   BACKUP_PASSPHRASE_FILE  Datei mit Passphrase (symmetrisch, AES-256), Rechte 600.
#   GNUPGHOME               optional: eigener GPG-Schlüsselbund.
#
# Weitere Einstellungen:
#   BACKUP_DIR          Zielverzeichnis (Standard /var/backups/stunden-<STAGE>; --out hat Vorrang).
#   BACKUP_KEEP_LOCAL   Anzahl lokal aufbewahrter Sätze dieses Skripts (Standard 14, 0 = alle behalten).
#                       Gelöscht werden nur Dateien dieses Skripts im Zielverzeichnis.
#   BACKUP_HOOK         Befehl, der nach einem erfolgreichen Lauf mit den beiden Dateien als Argumenten
#                       ausgeführt wird, z. B. Übergabe an das vorhandene restic-Repository:
#                         BACKUP_HOOK='restic backup --tag stunden --tag "$STAGE" "$@"'
#                       Das Skript ändert keine bestehende Backup-Konfiguration des Servers.
#
# Exit-Code ≠ 0 bei jedem Fehler; dann bleibt kein halbfertiges Archiv liegen.
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
MODE="compose"
ENV_FILE="$SCRIPT_DIR/.env"
SOURCE_URL=""
OUT_DIR="${BACKUP_DIR:-}"

die() { echo "backup: FEHLER: $*" >&2; exit 1; }
log() { echo "backup: $*" >&2; }

while [ $# -gt 0 ]; do
  case "$1" in
    --compose) MODE="compose"; ENV_FILE="${2:?--compose braucht eine .env-Datei}"; shift 2 ;;
    --url) MODE="url"; SOURCE_URL="${2:?--url braucht eine Verbindungs-URL}"; shift 2 ;;
    --out) OUT_DIR="${2:?--out braucht ein Verzeichnis}"; shift 2 ;;
    -h|--help) sed -n '2,40p' "$0"; exit 0 ;;
    *) die "Unbekannte Option: $1" ;;
  esac
done

if [ -n "${BACKUP_GPG_RECIPIENT:-}" ]; then
  ENCRYPT=(gpg --batch --yes --quiet --trust-model always --compress-algo none --encrypt --recipient "$BACKUP_GPG_RECIPIENT")
elif [ -n "${BACKUP_PASSPHRASE_FILE:-}" ]; then
  [ -r "$BACKUP_PASSPHRASE_FILE" ] || die "BACKUP_PASSPHRASE_FILE ist nicht lesbar."
  ENCRYPT=(gpg --batch --yes --quiet --pinentry-mode loopback --passphrase-file "$BACKUP_PASSPHRASE_FILE"
           --symmetric --cipher-algo AES256 --s2k-digest-algo SHA512 --s2k-count 65011712 --compress-algo none)
else
  die "Keine Verschlüsselung angegeben (BACKUP_GPG_RECIPIENT oder BACKUP_PASSPHRASE_FILE). Unverschlüsselte Backups gibt es nicht."
fi
command -v gpg >/dev/null || die "gpg fehlt."

if [ "$MODE" = "compose" ]; then
  [ -r "$ENV_FILE" ] || die "Env-Datei $ENV_FILE nicht gefunden (oder --url verwenden)."
  STAGE="$(sed -n 's/^STAGE=//p' "$ENV_FILE" | tail -n1 | tr -d '"'"'"' \r')"
  [ -n "$STAGE" ] || die "STAGE fehlt in $ENV_FILE."
  COMPOSE=(docker compose -f "$SCRIPT_DIR/docker-compose.yml" --env-file "$ENV_FILE")
  # Läuft im Container "db" als POSTGRES_USER über den lokalen Socket (wie das zentrale Backup).
  in_db() { "${COMPOSE[@]}" exec -T db sh -c "$1"; }
  PSQL_CMD=("${COMPOSE[@]}" exec -T db sh -c 'exec psql -X -q -At -v ON_ERROR_STOP=1 -U "$POSTGRES_USER" -d "${POSTGRES_DB:-stunden}"')
  pg_dump_snapshot() { in_db "exec pg_dump -U \"\$POSTGRES_USER\" -d \"\${POSTGRES_DB:-stunden}\" --format=custom --compress=6 --snapshot='$1'"; }
  pg_dump_roles() { in_db 'exec pg_dumpall -U "$POSTGRES_USER" --roles-only --no-role-passwords'; }
  pg_dump_version() { in_db 'pg_dump --version' | sed -E 's/^pg_dump \(PostgreSQL\) //'; }
else
  STAGE="${STAGE:-direct}"
  PSQL_CMD=(psql -X -q -At -v ON_ERROR_STOP=1 -d "$SOURCE_URL")
  pg_dump_snapshot() { pg_dump -d "$SOURCE_URL" --format=custom --compress=6 --snapshot="$1"; }
  pg_dump_roles() { pg_dumpall -d "$SOURCE_URL" --roles-only --no-role-passwords; }
  pg_dump_version() { pg_dump --version | sed -E 's/^pg_dump \(PostgreSQL\) //'; }
fi

OUT_DIR="${OUT_DIR:-/var/backups/stunden-$STAGE}"
mkdir -p "$OUT_DIR"
STAMP="$(date -u +%Y%m%dT%H%M%SZ)"
NAME="stunden-$STAGE-$STAMP.tar.gpg"
TARGET="$OUT_DIR/$NAME"
WORK="$(mktemp -d "$OUT_DIR/.work-XXXXXX")"
PSQL_PID=""
cleanup() {
  [ -n "$PSQL_PID" ] && kill "$PSQL_PID" 2>/dev/null || true
  rm -rf "$WORK" "$TARGET.partial"
}
trap cleanup EXIT

# Lesende Transaktion offenhalten, Schnappschuss exportieren, darin zählen und dumpen.
coproc PSQL { "${PSQL_CMD[@]}" 2>&1; }
PSQL_PID=$PSQL_PID
ask() { # eine Abfrage, deren Ausgabe mit der Zeile __END__ endet
  printf '%s\n\\echo __END__\n' "$1" >&"${PSQL[1]}"
  local line
  while IFS= read -r -t 120 line <&"${PSQL[0]}"; do
    [ "$line" = "__END__" ] && return 0
    printf '%s\n' "$line"
  done
  die "Keine Antwort der Datenbank (psql)."
}
ask "begin isolation level repeatable read read only;" >/dev/null
SNAPSHOT="$(ask "select pg_export_snapshot();")"
[[ "$SNAPSHOT" =~ ^[0-9A-F-]+$ ]] || die "Schnappschuss nicht erhalten: $SNAPSHOT"

HAS_MIGRATIONS="$(ask "select to_regclass('ops.schema_migrations') is not null;")"
{
  echo "format=stundenwerk.backup.v1"
  echo "created_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  echo "stage=$STAGE"
  ask "select 'database=' || current_database();
       select 'owner=' || pg_get_userbyid(datdba) from pg_database where datname = current_database();
       select 'server_version=' || current_setting('server_version');
       select 'tenants=' || count(*) from public.tenants;
       select 'employees=' || count(*) from public.employees;
       select 'time_entries=' || count(*) from public.time_entries;
       select 'audit_log=' || count(*) from public.audit_log;
       select 'rls_policies=' || count(*) from pg_policies where schemaname in ('public', 'auth');"
} > "$WORK/manifest.txt"
if [ "$HAS_MIGRATIONS" = "t" ]; then
  # seed.sql (Demo-Daten der Testumgebung) steht ebenfalls in ops.schema_migrations, ist aber keine Migration.
  ask "select name || E'\t' || sha256 from ops.schema_migrations where name <> 'seed.sql' order by name;" > "$WORK/migrations.tsv"
else
  : > "$WORK/migrations.tsv"
fi
echo "migrations=$(grep -c . "$WORK/migrations.tsv" || true)" >> "$WORK/manifest.txt"
grep -q '^tenants=[0-9]' "$WORK/manifest.txt" || die "Zählung fehlgeschlagen: $(tr '\n' ' ' < "$WORK/manifest.txt")"

pg_dump_snapshot "$SNAPSHOT" > "$WORK/database.dump" || die "pg_dump fehlgeschlagen."
ask "commit;" >/dev/null
eval "exec ${PSQL[1]}>&-"
wait "$PSQL_PID" 2>/dev/null || true
PSQL_PID=""
pg_dump_roles > "$WORK/roles.sql" || die "pg_dumpall --roles-only fehlgeschlagen."
echo "pg_dump_version=$(pg_dump_version)" >> "$WORK/manifest.txt"
echo "dump_sha256=$(sha256sum "$WORK/database.dump" | cut -d' ' -f1)" >> "$WORK/manifest.txt"
[ -s "$WORK/database.dump" ] || die "Dump ist leer."

tar -C "$WORK" -cf - manifest.txt migrations.tsv roles.sql database.dump | "${ENCRYPT[@]}" --output "$TARGET.partial" \
  || die "Verschlüsselung fehlgeschlagen."
SUMMARY="$(grep -E '^(tenants|employees|time_entries|migrations)=' "$WORK/manifest.txt" | tr '\n' ' ')"
rm -rf "$WORK"
mv "$TARGET.partial" "$TARGET"
(cd "$OUT_DIR" && sha256sum "$NAME" > "$NAME.sha256")
log "fertig: $TARGET ($(du -h "$TARGET" | cut -f1)); $SUMMARY"

if [ "${BACKUP_KEEP_LOCAL:-14}" -gt 0 ] 2>/dev/null; then
  # Nur eigene Sätze dieser Umgebung, älteste zuerst (Zeitstempel im Namen sortiert lexikalisch).
  mapfile -t OLD < <(find "$OUT_DIR" -maxdepth 1 -type f -name "stunden-$STAGE-*.tar.gpg" -printf '%f\n' | sort | head -n "-${BACKUP_KEEP_LOCAL:-14}")
  for f in "${OLD[@]}"; do rm -f "$OUT_DIR/$f" "$OUT_DIR/$f.sha256"; log "lokal entfernt (älter als die letzten ${BACKUP_KEEP_LOCAL:-14}): $f"; done
fi

if [ -n "${BACKUP_HOOK:-}" ]; then
  log "Übergabe an BACKUP_HOOK …"
  STAGE="$STAGE" bash -c "$BACKUP_HOOK" backup-hook "$TARGET" "$TARGET.sha256" || die "BACKUP_HOOK fehlgeschlagen (Archiv bleibt lokal erhalten: $TARGET)."
fi
echo "$TARGET"
