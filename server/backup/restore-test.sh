#!/usr/bin/env bash
# AppZentrale24 - Wiederherstellungstest (monatlich empfohlen, ändert nichts am Livesystem)
# Stellt den letzten Stand in ein Testverzeichnis wieder her und spielt jeden Datenbank-Dump
# in eine temporäre PostgreSQL-Instanz ein.
set -euo pipefail
set -a; . /etc/appzentrale24/backup.env; set +a

T=$(mktemp -d /var/tmp/restore-test.XXXX)
trap 'docker rm -f restore-test-pg >/dev/null 2>&1 || true; rm -rf "$T"' EXIT

restic restore latest --tag nightly --target "$T"
ls -la "$T/var/backups/appzentrale24/dumps"

docker run -d --name restore-test-pg -e POSTGRES_PASSWORD=restoretest postgres:16-alpine >/dev/null
until docker exec restore-test-pg pg_isready -U postgres >/dev/null 2>&1; do sleep 2; done
for f in "$T"/var/backups/appzentrale24/dumps/*.sql.gz; do
  echo ">> Teste $(basename "$f")"
  gzip -dc "$f" | docker exec -i restore-test-pg psql -q -v ON_ERROR_STOP=0 -U postgres -d postgres >/dev/null
done
docker exec restore-test-pg psql -U postgres -Atc "select datname from pg_database where not datistemplate"
echo "Wiederherstellungstest abgeschlossen: $(date -Is)"
