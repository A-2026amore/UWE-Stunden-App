#!/usr/bin/env bash
# Updates the isolated test environment (STAGE=test) to a released branch or tag in one step:
# backup → fetch/checkout → build → migrate → restart app → health check → optional test accounts.
# Only the containers stunden-test-* are touched. Run on the server inside the checkout (e.g. /srv/stunden-test).
#
#   deploy/update-test.sh release/1.0                      # update only
#   deploy/update-test.sh release/1.0 --seed-test-env      # plus test accounts (passwords only on this console)
#   deploy/update-test.sh release/1.0 --no-backup          # skip the backup (not recommended)
#
# Environment: BACKUP_PASSPHRASE_FILE or BACKUP_GPG_RECIPIENT for deploy/backup.sh (see deploy/README.md),
# TEST_URL (default https://stunden-test.appzentrale24.de), SEED_ADMIN_EMAIL (optional, real address of the tester).
set -euo pipefail

REF="${1:-}"
shift || true
SEED=0
BACKUP=1
for arg in "$@"; do
  case "$arg" in
    --seed-test-env) SEED=1 ;;
    --no-backup) BACKUP=0 ;;
    *) echo "Unbekannte Option: $arg" >&2; exit 2 ;;
  esac
done
if [ -z "$REF" ]; then
  echo "Aufruf: deploy/update-test.sh <branch-oder-tag> [--seed-test-env] [--no-backup]" >&2
  exit 2
fi

cd "$(dirname "$0")/.."
ENV_FILE=deploy/.env
[ -f "$ENV_FILE" ] || { echo "deploy/.env fehlt (Vorlage: deploy/.env.example)." >&2; exit 1; }
STAGE="$(sed -n 's/^STAGE=//p' "$ENV_FILE" | tail -n1 | tr -d '"'"'"' ')"
if [ "$STAGE" != "test" ]; then
  echo "Abbruch: deploy/.env hat STAGE='$STAGE'. Dieses Skript ist nur für die Testumgebung (STAGE=test)." >&2
  exit 1
fi
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Abbruch: Arbeitsverzeichnis hat lokale Änderungen. Bitte zuerst prüfen (git status)." >&2
  exit 1
fi

C=(docker compose -f deploy/docker-compose.yml --env-file "$ENV_FILE")
TEST_URL="${TEST_URL:-https://stunden-test.appzentrale24.de}"

step() { printf '\n==> %s\n' "$*"; }

step "Konfiguration prüfen"
"${C[@]}" config --quiet

if [ "$BACKUP" = 1 ]; then
  if docker inspect --type container stunden-test-db >/dev/null 2>&1; then
    step "Sicherung vor dem Update"
    deploy/backup.sh --compose "$ENV_FILE"
  else
    echo "Keine laufende Testdatenbank gefunden – Sicherung entfällt (Erstinstallation)."
  fi
fi

step "Stand $REF holen"
git fetch --tags origin
if [[ "$REF" =~ ^[0-9a-f]{40}$ ]]; then
  # A full commit id is always taken as that commit, never as a branch that happens to carry the same name.
  git -c advice.detachedHead=false checkout --detach "$REF^{commit}"
  [ "$(git rev-parse HEAD)" = "$REF" ] || { echo "Abbruch: ausgecheckter Stand ist nicht $REF." >&2; exit 1; }
elif git show-ref --verify --quiet "refs/remotes/origin/$REF"; then
  git checkout -B "$REF" "origin/$REF"
else
  git checkout --detach "$REF"
fi
APP_COMMIT="$(git rev-parse --short HEAD)"
export APP_COMMIT
echo "Commit: $APP_COMMIT"

step "Image bauen"
"${C[@]}" build --build-arg APP_COMMIT="$APP_COMMIT"

step "Datenbank starten und Migrationen einspielen"
"${C[@]}" up -d db
"${C[@]}" run --rm migrate

step "App neu starten"
"${C[@]}" up -d stundenwerk-app

step "Warten auf healthy"
for _ in $(seq 1 30); do
  status="$(docker inspect --type container -f '{{.State.Health.Status}}' stunden-test-app 2>/dev/null || echo unbekannt)"
  [ "$status" = healthy ] && break
  sleep 3
done
echo "stunden-test-app: $status"
[ "$status" = healthy ] || { echo "App wurde nicht healthy. Logs: docker logs stunden-test-app" >&2; exit 1; }

step "Erreichbarkeit von außen"
if curl -fsS -o /dev/null -w '%{http_code}\n' "$TEST_URL/"; then :; else
  echo "Warnung: $TEST_URL ist nicht erreichbar (Caddy/DNS prüfen)." >&2
fi

if [ "$SEED" = 1 ]; then
  step "Testzugänge anlegen (Passwörter erscheinen NUR hier – sofort in einen Passwort-Manager übernehmen)"
  extra=()
  [ -n "${SEED_ADMIN_EMAIL:-}" ] && extra+=("--admin-email=$SEED_ADMIN_EMAIL")
  "${C[@]}" run --rm migrate node --experimental-strip-types --disable-warning=ExperimentalWarning \
    --import ./server/register.mjs server/src/cli.ts seed-test-env --confirm-test-environment \
    --domain=stunden-test.example "${extra[@]}"
fi

step "Fertig: $TEST_URL läuft mit $APP_COMMIT"
