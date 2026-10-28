#!/usr/bin/env bash
# Wiederherstellungsprobe: spielt ein Backup von deploy/backup.sh in eine frische Wegwerf-Datenbank ein
# und prüft es. Die laufende Umgebung wird dabei nicht berührt. Anleitung: docs/betrieb.md, Abschnitt 5.
#
#   deploy/restore-test.sh [--local | --docker [IMAGE] | --server-url URL] [--migrations DIR] [--keep] BACKUP.tar.gpg
#
# Ziel (eine Wegwerf-Datenbank, danach wieder entfernt):
#   --local            Eigener PostgreSQL-Cluster per initdb in einem Temp-Verzeichnis, nur Unix-Socket
#                      (Standard, wenn initdb vorhanden ist; PG_BIN = Verzeichnis der Programme).
#   --docker [IMAGE]   Wegwerf-Container ohne Netz und ohne Volume (Standard-Image: das gepinnte postgres:16
#                      aus deploy/docker-compose.yml).
#   --server-url URL   Vorhandener PostgreSQL-Server, Verbindung als Superuser (z. B. CI-Dienst). Legt eine
#                      Datenbank restore_test_… an und löscht sie danach. Rollen sind clusterweit und werden dort
#                      angelegt bzw. angeglichen – NIE gegen den Produktionsserver verwenden.
# Weitere Optionen:
#   --migrations DIR   Vergleicht den Migrationsstand des Backups mit den Dateien in DIR (z. B. db/migrations).
#   --keep             Wegwerf-Datenbank nicht entfernen (zum Nachsehen; Verbindungsdaten werden ausgegeben).
# Entschlüsselung: BACKUP_PASSPHRASE_FILE (symmetrisch) oder privater Schlüssel im GPG-Schlüsselbund (GNUPGHOME).
#
# Prüfungen: Prüfsumme (.sha256 neben dem Archiv), Entschlüsselung, Dump-Prüfsumme im Manifest, pg_restore ohne
# Fehler, Zeilenzahlen (Mandanten, Mitarbeitende, Arbeitszeiten, Protokoll) = Manifest, Migrationsstand = Manifest,
# RLS auf allen Tabellen aktiv + Richtlinien vollständig + Anfragerolle sieht ohne Anmeldung nichts, Laufzeitrollen
# ohne BYPASSRLS, SECURITY-DEFINER-Funktionen mit festem search_path.
# Exit-Code 0 nur, wenn alle Prüfungen bestanden sind.
set -Eeuo pipefail
umask 077

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEFAULT_IMAGE="$(sed -n 's/^ *image: \(postgres:16[^ ]*\).*/\1/p' "$SCRIPT_DIR/docker-compose.yml" | head -n1)"
TARGET_MODE=""
IMAGE=""
SERVER_URL=""
MIGRATIONS_DIR=""
KEEP=0
ARCHIVE=""

while [ $# -gt 0 ]; do
  case "$1" in
    --local) TARGET_MODE="local"; shift ;;
    --docker) TARGET_MODE="docker"; if [ $# -gt 1 ] && [[ "$2" != -* ]] && [[ "$2" != *.gpg ]]; then IMAGE="$2"; shift; fi; shift ;;
    --server-url) TARGET_MODE="server"; SERVER_URL="${2:?--server-url braucht eine URL}"; shift 2 ;;
    --migrations) MIGRATIONS_DIR="${2:?--migrations braucht ein Verzeichnis}"; shift 2 ;;
    --keep) KEEP=1; shift ;;
    -h|--help) sed -n '2,27p' "$0"; exit 0 ;;
    -*) echo "Unbekannte Option: $1" >&2; exit 2 ;;
    *) ARCHIVE="$1"; shift ;;
  esac
done
[ -n "$ARCHIVE" ] || { echo "Aufruf: $0 [--local|--docker|--server-url URL] [--migrations DIR] [--keep] BACKUP.tar.gpg" >&2; exit 2; }
[ -r "$ARCHIVE" ] || { echo "Backup $ARCHIVE nicht lesbar." >&2; exit 2; }

find_pg_bin() {
  if [ -n "${PG_BIN:-}" ]; then echo "$PG_BIN"; return; fi
  local v
  for v in $(ls /usr/lib/postgresql 2>/dev/null | sort -rn); do
    [ -x "/usr/lib/postgresql/$v/bin/initdb" ] && { echo "/usr/lib/postgresql/$v/bin"; return; }
  done
  dirname "$(command -v initdb 2>/dev/null || echo /nonexistent/initdb)"
}
if [ -z "$TARGET_MODE" ]; then
  if [ -x "$(find_pg_bin)/initdb" ]; then TARGET_MODE="local"; else TARGET_MODE="docker"; fi
fi

FAILED=0
ok()   { printf 'OK      %s\n' "$*"; }
fail() { printf 'FEHLER  %s\n' "$*"; FAILED=1; }
note() { printf 'HINWEIS %s\n' "$*"; }
abort() { fail "$*"; echo "Wiederherstellungsprobe abgebrochen." ; exit 1; }
START=$(date +%s)

WORK="$(mktemp -d /tmp/stunden-restore-XXXXXX)"
CLUSTER=""; CONTAINER=""; SERVER_DB=""
cleanup() {
  if [ "$KEEP" = 1 ]; then
    echo "--keep: Wegwerf-Datenbank bleibt bestehen (${CLUSTER:+Cluster $CLUSTER/data, Socket $CLUSTER}${CONTAINER:+Container $CONTAINER}${SERVER_DB:+Datenbank $SERVER_DB}). Entpackte Dateien: $WORK"
    return
  fi
  if [ -n "$CLUSTER" ]; then as_pg "$PG_BIN_DIR/pg_ctl" -D "$CLUSTER/data" -m immediate stop >/dev/null 2>&1 || true; rm -rf "$CLUSTER"; fi
  if [ -n "$CONTAINER" ]; then docker rm -f "$CONTAINER" >/dev/null 2>&1 || true; fi
  if [ -n "$SERVER_DB" ]; then psql -X -q -d "$SERVER_URL" -c "drop database if exists \"$SERVER_DB\" with (force)" >/dev/null 2>&1 || true; fi
  rm -rf "$WORK"
}
trap cleanup EXIT

echo "Wiederherstellungsprobe: $(basename "$ARCHIVE") → Ziel: $TARGET_MODE"

# 1. Prüfsumme und Entschlüsselung
if [ -r "$ARCHIVE.sha256" ]; then
  if (cd "$(dirname "$ARCHIVE")" && sha256sum --quiet -c "$(basename "$ARCHIVE").sha256" >/dev/null 2>&1); then ok "Prüfsumme (SHA-256) stimmt"
  else abort "Prüfsumme stimmt nicht – Archiv beschädigt oder verändert"; fi
else
  abort "Prüfsummendatei $ARCHIVE.sha256 fehlt"
fi
DECRYPT=(gpg --batch --quiet --decrypt)
[ -n "${BACKUP_PASSPHRASE_FILE:-}" ] && DECRYPT=(gpg --batch --quiet --pinentry-mode loopback --passphrase-file "$BACKUP_PASSPHRASE_FILE" --decrypt)
if "${DECRYPT[@]}" "$ARCHIVE" 2>"$WORK/gpg.err" | tar -C "$WORK" -xf - manifest.txt migrations.tsv roles.sql database.dump 2>>"$WORK/gpg.err"; then
  ok "Entschlüsselt und entpackt"
else
  abort "Entschlüsseln/Entpacken fehlgeschlagen: $(head -c 300 "$WORK/gpg.err" | tr '\n' ' ')"
fi
manifest() { sed -n "s/^$1=//p" "$WORK/manifest.txt" | head -n1; }
[ "$(manifest format)" = "stundenwerk.backup.v1" ] || abort "Unbekanntes Backup-Format"
echo "        Backup vom $(manifest created_at), Umgebung $(manifest stage), PostgreSQL $(manifest server_version)"
if [ "$(sha256sum "$WORK/database.dump" | cut -d' ' -f1)" = "$(manifest dump_sha256)" ]; then ok "Dump-Prüfsumme im Manifest stimmt"; else abort "Dump-Prüfsumme weicht vom Manifest ab"; fi

# 2. Wegwerf-Ziel bereitstellen
DB="$(manifest database)"; OWNER="$(manifest owner)"
case "$TARGET_MODE" in
  local)
    PG_BIN_DIR="$(find_pg_bin)"
    [ -x "$PG_BIN_DIR/initdb" ] || abort "initdb nicht gefunden (PG_BIN setzen oder --docker verwenden)"
    CLUSTER="$(mktemp -d /tmp/stunden-rpg-XXXXXX)"   # kurzer Pfad: Unix-Socket-Namen sind auf 107 Zeichen begrenzt
    if [ "$(id -u)" = 0 ]; then chown postgres "$CLUSTER"; as_pg() { runuser -u postgres -- "$@"; }; else as_pg() { "$@"; }; fi
    as_pg "$PG_BIN_DIR/initdb" -D "$CLUSTER/data" -U postgres --auth=trust --encoding=UTF8 --locale=C.UTF-8 --no-sync >"$WORK/initdb.log" 2>&1 \
      || abort "initdb fehlgeschlagen: $(tail -n 3 "$WORK/initdb.log")"
    as_pg "$PG_BIN_DIR/pg_ctl" -D "$CLUSTER/data" -w -l "$CLUSTER/server.log" \
      -o "-c listen_addresses='' -k $CLUSTER -c fsync=off -c timezone=Europe/Berlin" start >/dev/null \
      || abort "Wegwerf-Cluster startet nicht: $(tail -n 3 "$CLUSTER/server.log" 2>/dev/null)"
    t_psql() { local db="$1"; shift; "$PG_BIN_DIR/psql" -X -h "$CLUSTER" -U postgres -d "$db" "$@"; }
    t_restore() { "$PG_BIN_DIR/pg_restore" -h "$CLUSTER" -U postgres -d "$1" --exit-on-error < "$WORK/database.dump"; }
    ok "Wegwerf-Cluster gestartet ($("$PG_BIN_DIR/postgres" --version | sed 's/^postgres //'))"
    ;;
  docker)
    IMAGE="${IMAGE:-$DEFAULT_IMAGE}"
    command -v docker >/dev/null || abort "docker fehlt (oder --local verwenden)"
    CONTAINER="stunden-restore-test-$(date +%s)-$$"
    docker run -d --rm --name "$CONTAINER" --network none -e POSTGRES_PASSWORD="$(openssl rand -hex 16)" \
      -e POSTGRES_USER=postgres -e TZ=Europe/Berlin "$IMAGE" >/dev/null || abort "Wegwerf-Container startet nicht"
    for _ in $(seq 1 60); do docker exec "$CONTAINER" pg_isready -U postgres -q 2>/dev/null && break; sleep 1; done
    # Das offizielle Image startet einmal neu (Initialisierung) – zweite Bereitschaft abwarten.
    sleep 2; for _ in $(seq 1 30); do docker exec "$CONTAINER" pg_isready -U postgres -q 2>/dev/null && break; sleep 1; done
    t_psql() { local db="$1"; shift; docker exec -i "$CONTAINER" psql -X -U postgres -d "$db" "$@"; }
    t_restore() { docker exec -i "$CONTAINER" pg_restore -U postgres -d "$1" --exit-on-error < "$WORK/database.dump"; }
    ok "Wegwerf-Container $CONTAINER gestartet ($IMAGE, ohne Netz)"
    ;;
  server)
    DB="restore_test_$(date +%s)_$$"; SERVER_DB="$DB"
    db_url() { local base="${SERVER_URL%%\?*}" q=""; [[ "$SERVER_URL" == *\?* ]] && q="?${SERVER_URL#*\?}"; echo "${base%/*}/$1$q"; }
    t_psql() { local db="$1"; shift; if [ "$db" = postgres ]; then psql -X -d "$SERVER_URL" "$@"; else psql -X -d "$(db_url "$db")" "$@"; fi; }
    t_restore() { pg_restore -d "$(db_url "$1")" --exit-on-error < "$WORK/database.dump"; }
    ok "Server erreichbar, Wegwerf-Datenbank $DB"
    ;;
esac
q() { t_psql "$DB" -At -v ON_ERROR_STOP=1 -c "$1"; }

# 3. Rollen, Datenbank, Dump
t_psql postgres -q -v ON_ERROR_STOP=0 -f - < "$WORK/roles.sql" >"$WORK/roles.log" 2>&1 || true
if grep -E 'ERROR' "$WORK/roles.log" | grep -vq 'already exists'; then
  abort "Rollen nicht einspielbar: $(grep -E 'ERROR' "$WORK/roles.log" | grep -v 'already exists' | head -n 3 | tr '\n' ' ')"
fi
ok "Rollen eingespielt (ohne Passwörter; app_api-Passwort setzt danach der Migrationsjob)"
t_psql postgres -q -v ON_ERROR_STOP=1 -c "create database \"$DB\" owner \"$OWNER\" template template0 encoding 'UTF8'" >/dev/null \
  || abort "Datenbank $DB nicht anlegbar"
if t_restore "$DB" >"$WORK/restore.log" 2>&1; then ok "pg_restore ohne Fehler"
else abort "pg_restore fehlgeschlagen: $(head -n 5 "$WORK/restore.log" | tr '\n' ' ')"; fi

# 4. Inhalt
for t in tenants employees time_entries audit_log; do
  want="$(manifest "$t")"; got="$(q "select count(*) from public.$t")"
  if [ "$want" = "$got" ]; then ok "Zeilen public.$t: $got"; else fail "Zeilen public.$t: $got statt $want"; fi
done

# 5. Migrationsstand
HAS_OPS="$(q "select to_regclass('ops.schema_migrations') is not null")"
if [ "$HAS_OPS" = t ]; then
  q "select name || E'\t' || sha256 from ops.schema_migrations where name <> 'seed.sql' order by name" > "$WORK/migrations.restored.tsv"
else
  : > "$WORK/migrations.restored.tsv"
fi
if cmp -s <(grep . "$WORK/migrations.tsv" || true) <(grep . "$WORK/migrations.restored.tsv" || true); then
  ok "Migrationsstand wie im Backup: $(grep -c . "$WORK/migrations.tsv" || true) Migrationen, zuletzt $(tail -n1 "$WORK/migrations.tsv" | cut -f1)"
else
  fail "Migrationsstand weicht vom Manifest ab"
fi
if [ -n "$MIGRATIONS_DIR" ]; then
  newer=0
  while IFS= read -r f; do
    name="$(basename "$f")"; sum="$(sha256sum "$f" | cut -d' ' -f1)"
    inbk="$(awk -F'\t' -v n="$name" '$1 == n { print $2 }' "$WORK/migrations.tsv")"
    if [ -z "$inbk" ]; then newer=$((newer + 1)); elif [ "$inbk" != "$sum" ]; then fail "Migration $name im Backup hat eine andere Prüfsumme als im Code"; fi
  done < <(find "$MIGRATIONS_DIR" -maxdepth 1 -name '[0-9][0-9][0-9][0-9]_*.sql' | sort)
  while IFS=$'\t' read -r name _; do
    [ -n "$name" ] && [ ! -f "$MIGRATIONS_DIR/$name" ] && fail "Migration $name aus dem Backup fehlt im Code (Backup ist neuer als der Code-Stand)"
  done < "$WORK/migrations.tsv"
  if [ "$newer" -gt 0 ]; then note "$newer neuere Migration(en) im Code – nach der Wiederherstellung den Migrationsjob ausführen"
  else ok "Migrationsstand passt zum Code in $MIGRATIONS_DIR"; fi
fi

# 6. Schutzmechanismen
no_rls="$(q "select coalesce(string_agg(n.nspname || '.' || c.relname, ', '), '') from pg_class c join pg_namespace n on n.oid = c.relnamespace
             where c.relkind in ('r', 'p') and n.nspname in ('public', 'auth') and not c.relrowsecurity")"
tables="$(q "select count(*) from pg_class c join pg_namespace n on n.oid = c.relnamespace where c.relkind in ('r', 'p') and n.nspname in ('public', 'auth')")"
if [ -z "$no_rls" ] && [ "$tables" -gt 0 ]; then ok "RLS auf allen $tables Tabellen (public, auth) aktiv"; else fail "RLS fehlt auf: ${no_rls:-keine Tabellen gefunden}"; fi
pol="$(q "select count(*) from pg_policies where schemaname in ('public', 'auth')")"
if [ "$pol" = "$(manifest rls_policies)" ] && [ "$pol" -gt 0 ]; then ok "RLS-Richtlinien vollständig ($pol)"; else fail "RLS-Richtlinien: $pol statt $(manifest rls_policies)"; fi
bypass="$(q "select coalesce(string_agg(rolname, ', '), '') from pg_roles where rolname in ('app_api', 'app_user', 'app_anon', 'app_auth') and (rolbypassrls or rolsuper)")"
roles="$(q "select count(*) from pg_roles where rolname in ('app_api', 'app_user', 'app_anon', 'app_auth')")"
if [ "$roles" = 4 ] && [ -z "$bypass" ]; then ok "Laufzeit- und Anfragerollen vorhanden, ohne BYPASSRLS"; else fail "Rollen unvollständig ($roles/4) oder mit BYPASSRLS: $bypass"; fi
seen="$(t_psql "$DB" -q -At -v ON_ERROR_STOP=1 -c "begin" -c "set local role app_user" -c "select count(*) from public.time_entries" -c "rollback")"
if [ "$(manifest time_entries)" = 0 ]; then note "Keine Arbeitszeiten im Backup – Sichtbarkeitsprobe ohne Aussagekraft"
elif [ "$seen" = 0 ]; then ok "Anfragerolle ohne Anmeldung sieht 0 von $(manifest time_entries) Arbeitszeiten (RLS greift)"
else fail "Anfragerolle ohne Anmeldung sieht $seen Arbeitszeiten"; fi
bad_definer="$(q "select count(*) from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                 where p.prosecdef and n.nspname in ('public', 'auth', 'private', 'ops')
                   and (p.proconfig is null or not ('search_path=\"\"' = any(p.proconfig)))")"
if [ "$bad_definer" = 0 ]; then ok "SECURITY-DEFINER-Funktionen mit festem search_path"; else fail "$bad_definer SECURITY-DEFINER-Funktion(en) ohne festen search_path"; fi

echo "Dauer: $(( $(date +%s) - START )) s"
if [ "$FAILED" = 0 ]; then echo "ERGEBNIS: Wiederherstellung erfolgreich geprüft."; else echo "ERGEBNIS: Wiederherstellungsprobe FEHLGESCHLAGEN."; exit 1; fi
