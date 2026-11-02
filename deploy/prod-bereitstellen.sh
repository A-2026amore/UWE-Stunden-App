#!/usr/bin/env bash
# Production environment of Schichtklar24 (app.schichtklar24.de) – first installation AND later updates.
# Run with sudo on the server, with the commit that is already running on the test environment:
#
#   sudo bash /srv/stunden-test/deploy/prod-bereitstellen.sh <40-stelliger Commit>
#
# Rules (enforced): only a commit that runs on the test environment (/var/lib/stunden-test/deployed-commit) and
# came in as a signed package (/srv/git/UWE-Stunden-App.git) is deployed; GitHub is never contacted.
# Separate from the test environment: checkout /srv/stunden-prod, containers stunden-prod-app / stunden-prod-db,
# own database volume, own secrets (deploy/.env, mode 600), own backup passphrase /root/.stunden-prod-backup-pass,
# image tag "prod". The database starts EMPTY: no test companies, no test accounts (db/seed.sql is never used).
# The e-mail settings (SMTP_*) are taken over from the test environment.
#
# Steps: backup of the running production database first (updates only) → checkout → build → migrate →
# restart → health check → Storage Box repository stundenwerk-prod (if the Storage Box key of the test environment
# works) → Caddy site block for the host (only if missing: copy of the Caddyfile, validate, reload, restore on error)
# → backup with restore probe. Afterwards (printed at the end): first super admin and daily backup.
# Options (environment): PROD_HOST (default app.schichtklar24.de), CADDY_CONTAINER (default: the Caddy in "proxy").
set -euo pipefail

# Second mode, after the first installation: create the first super admin (password typed hidden).
#   sudo bash /srv/stunden-prod/deploy/prod-bereitstellen.sh --super-admin <e-mail>
super_admin() {
  local email="${1:-}" dir=/srv/stunden-prod pw pw2
  [ "$(id -u)" = 0 ] || { echo "Bitte mit sudo ausführen." >&2; exit 1; }
  [ -n "$email" ] || { echo "Aufruf: sudo bash prod-bereitstellen.sh --super-admin <e-mail>" >&2; exit 2; }
  [ -f "$dir/deploy/.env" ] || { echo "Produktion ist noch nicht eingerichtet ($dir/deploy/.env fehlt)." >&2; exit 1; }
  read -rsp "Passwort für $email (mind. 10 Zeichen, wird nicht angezeigt): " pw; echo
  read -rsp "Passwort wiederholen: " pw2; echo
  [ "$pw" = "$pw2" ] || { echo "Die Passwörter stimmen nicht überein – nichts verändert." >&2; exit 1; }
  printf '%s\n' "$pw" | docker compose -f "$dir/deploy/docker-compose.yml" --env-file "$dir/deploy/.env" run --rm -T migrate \
    node --experimental-strip-types --disable-warning=ExperimentalWarning --import ./server/register.mjs \
    server/src/cli.ts create-super-admin "$email"
}

main() {
COMMIT="${1:-}"
HOST="${PROD_HOST:-app.schichtklar24.de}"
DIR=/srv/stunden-prod
BARE=/srv/git/UWE-Stunden-App.git
TEST_DIR=/srv/stunden-test
CONF=/etc/stunden-prod
STATE=/var/lib/stunden-prod
PASS_FILE=/root/.stunden-prod-backup-pass
RESTIC_ENV=/root/.stunden-prod-restic.env
RESTIC_PASS=/root/.stunden-prod-restic-pass

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nABBRUCH: %s\n' "$*" >&2; exit 1; }

[[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || die "Aufruf: sudo bash prod-bereitstellen.sh <40-stelliger Commit-SHA>"
[ "$(id -u)" = 0 ] || die "Bitte mit sudo ausführen."
[[ "$HOST" =~ ^[a-z0-9.-]+\.[a-z]{2,}$ ]] || die "PROD_HOST ist keine gültige Adresse."
for c in docker git openssl flock gpg; do command -v "$c" >/dev/null || die "$c fehlt."; done
docker compose version >/dev/null 2>&1 || die "Docker Compose fehlt."

TESTED="$({ tr -d '[:space:]' < /var/lib/stunden-test/deployed-commit; } 2>/dev/null || true)"
[ "$TESTED" = "$COMMIT" ] || die "Auf der Testumgebung läuft ${TESTED:-nichts}, nicht $COMMIT. In Produktion kommt nur, was im Test läuft."
[ -d "$BARE" ] || die "$BARE fehlt (Pakete werden mit stunden-test-paket übernommen)."
git -C "$BARE" show-ref --verify --quiet "refs/pakete/$COMMIT" \
  || die "Commit $COMMIT kam in keinem geprüften Paket an ($BARE refs/pakete/)."

install -d -m 755 "$STATE" "$CONF"
exec 9>/run/stunden-prod.lock
flock -n 9 || die "Es läuft schon eine Bereitstellung oder Sicherung der Produktion."
status() { printf '%s %s\n' "$(date -Is)" "$*" | tee -a "$STATE/status.txt"; }

say "Caddy im Netz proxy (nur lesen)"
docker network inspect proxy >/dev/null 2>&1 || die "Docker-Netz 'proxy' fehlt."
if [ -n "${CADDY_CONTAINER:-}" ]; then CADDY="$CADDY_CONTAINER"; else
  CADDY="$(docker ps --filter network=proxy --format '{{.Names}} {{.Image}}' | awk 'tolower($2) ~ /caddy/ {print $1}')"
  [ "$(printf '%s\n' "$CADDY" | grep -c .)" = 1 ] || die "Caddy-Container nicht eindeutig: '$CADDY' – bitte CADDY_CONTAINER=<name> setzen."
fi
CADDY_IP="$(docker inspect -f '{{with index .NetworkSettings.Networks "proxy"}}{{.IPAddress}}{{end}}' "$CADDY")"
[[ "$CADDY_IP" =~ ^[0-9.]+$ ]] || die "Container $CADDY hat keine Adresse im Netz 'proxy'."
echo "Caddy: $CADDY ($CADDY_IP)"

FIRST=1
docker inspect --type container stunden-prod-db >/dev/null 2>&1 && FIRST=0
if [ "$FIRST" = 0 ] && [ -f "$DIR/deploy/.env" ]; then
  say "Sicherung der laufenden Produktion vor dem Update"
  ( cd "$DIR" && STAGE=prod BACKUP_PASSPHRASE_FILE="$PASS_FILE" bash deploy/sicherung.sh ) \
    || die "Sicherung vor dem Update fehlgeschlagen – nichts verändert ($STATE/backup.log)."
fi

say "Code nach $DIR, fest auf $COMMIT"
if [ -d "$DIR/.git" ]; then
  [ -z "$(git -C "$DIR" status --porcelain --untracked-files=no)" ] || die "$DIR hat lokale Änderungen – nichts verändert."
  git -C "$DIR" remote set-url origin "$BARE"
elif [ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
  die "$DIR existiert und ist kein Git-Checkout – nichts verändert."
else
  git clone --quiet --no-checkout "$BARE" "$DIR"
fi
git -C "$DIR" fetch --quiet --no-tags origin "+refs/pakete/$COMMIT:refs/pakete/$COMMIT"
git -C "$DIR" -c advice.detachedHead=false checkout --quiet --detach "$COMMIT^{commit}"
[ "$(git -C "$DIR" rev-parse HEAD)" = "$COMMIT" ] || die "Checkout entspricht nicht $COMMIT."
cd "$DIR"

say "Konfiguration deploy/.env (eigene Geheimnisse, Rechte 600)"
umask 077
if [ ! -f deploy/.env ]; then
  getv() { sed -n "s/^$1=//p" "$TEST_DIR/deploy/.env" 2>/dev/null | tail -n1; }
  V_PG="$(openssl rand -hex 32)" V_APP="$(openssl rand -hex 32)" V_TOTP="$(openssl rand -base64 32)" \
  V_IP="$CADDY_IP" V_HOST="$HOST" \
  S_HOST="$(getv SMTP_HOST)" S_PORT="$(getv SMTP_PORT)" S_TLS="$(getv SMTP_TLS)" S_USER="$(getv SMTP_USER)" \
  S_PASS="$(getv SMTP_PASSWORD)" S_FROM="$(getv SMTP_FROM)" awk '
    /^POSTGRES_PASSWORD=/   { print "POSTGRES_PASSWORD=" ENVIRON["V_PG"]; next }
    /^APP_DB_PASSWORD=/     { print "APP_DB_PASSWORD=" ENVIRON["V_APP"]; next }
    /^TOTP_ENCRYPTION_KEY=/ { print "TOTP_ENCRYPTION_KEY=" ENVIRON["V_TOTP"]; next }
    /^TRUSTED_PROXY_IP=/    { print "TRUSTED_PROXY_IP=" ENVIRON["V_IP"]; next }
    /^STAGE=/               { print "STAGE=prod"; next }
    /^APP_HOSTNAME=/        { print "APP_HOSTNAME=" ENVIRON["V_HOST"]; next }
    /^APP_IMAGE_TAG=/       { print "APP_IMAGE_TAG=prod"; next }
    /^SMTP_HOST=/           { print "SMTP_HOST=" ENVIRON["S_HOST"]; next }
    /^SMTP_PORT=/           { print "SMTP_PORT=" (ENVIRON["S_PORT"] == "" ? "587" : ENVIRON["S_PORT"]); next }
    /^SMTP_TLS=/            { print "SMTP_TLS=" (ENVIRON["S_TLS"] == "" ? "starttls" : ENVIRON["S_TLS"]); next }
    /^SMTP_USER=/           { print "SMTP_USER=" ENVIRON["S_USER"]; next }
    /^SMTP_PASSWORD=/       { print "SMTP_PASSWORD=" ENVIRON["S_PASS"]; next }
    /^SMTP_FROM=/           { print "SMTP_FROM=" ENVIRON["S_FROM"]; next }
    { print }' deploy/.env.example > deploy/.env.tmp
  mv deploy/.env.tmp deploy/.env
  grep -q '^SMTP_HOST=.' deploy/.env && echo "angelegt (E-Mail-Versand vom Test übernommen)" || echo "angelegt (ohne E-Mail-Versand)"
else
  grep -q '^STAGE=prod$' deploy/.env || die "deploy/.env vorhanden, aber nicht STAGE=prod – nichts verändert."
  echo "vorhanden, unverändert"
fi
chmod 600 deploy/.env
[ -s "$PASS_FILE" ] || openssl rand -hex 32 > "$PASS_FILE"
chmod 600 "$PASS_FILE"
umask 022

C=(docker compose -f deploy/docker-compose.yml --env-file deploy/.env)
"${C[@]}" config --quiet
export APP_COMMIT="${COMMIT:0:7}"
status "Bereitstellung ${COMMIT:0:12} beginnt"
say "Image bauen (stunden-app:prod)"
"${C[@]}" build --build-arg APP_COMMIT="$APP_COMMIT"
say "Datenbank starten und Migrationen einspielen (ohne Testdaten)"
"${C[@]}" up -d db
"${C[@]}" run --rm migrate
say "App starten"
"${C[@]}" up -d stundenwerk-app
s=unbekannt
for _ in $(seq 1 40); do
  s="$(docker inspect --type container -f '{{.State.Health.Status}}' stunden-prod-app 2>/dev/null || echo unbekannt)"
  [ "$s" = healthy ] && break
  sleep 3
done
[ "$s" = healthy ] || { status "FEHLER: App nicht healthy (docker logs stunden-prod-app)"; die "App wurde nicht healthy (docker logs stunden-prod-app)."; }
printf '%s\n' "$COMMIT" > "$CONF/approved-commit"
printf '%s\n' "$COMMIT" > "$STATE/deployed-commit"
status "OK: App läuft mit ${COMMIT:0:12}"

say "Storage Box (eigenes Repository stundenwerk-prod)"
if [ -f "$RESTIC_ENV" ]; then
  echo "schon eingerichtet"
elif command -v restic >/dev/null && echo "ls" | sftp -q -b - -o BatchMode=yes stunden-storagebox >/dev/null 2>&1; then
  ( umask 077
    [ -s "$RESTIC_PASS" ] || openssl rand -base64 48 | tr -d '\n' > "$RESTIC_PASS"
    printf 'RESTIC_REPOSITORY=%s\nRESTIC_PASSWORD_FILE=%s\n' "sftp:stunden-storagebox:stundenwerk-prod" "$RESTIC_PASS" > "$RESTIC_ENV.tmp"
    mv "$RESTIC_ENV.tmp" "$RESTIC_ENV" )
  chmod 600 "$RESTIC_ENV" "$RESTIC_PASS"
  ( set -a; . "$RESTIC_ENV"; set +a; restic cat config >/dev/null 2>&1 || restic init >/dev/null ) \
    && echo "Repository stundenwerk-prod bereit" || { rm -f "$RESTIC_ENV"; echo "Hinweis: Repository nicht angelegt – Sicherung vorerst nur lokal."; }
else
  echo "Hinweis: Storage-Box-Zugang des Tests nicht nutzbar – Sicherung vorerst nur lokal."
fi

say "Caddy-Abschnitt für $HOST"
CF="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/etc/caddy/Caddyfile"}}{{.Source}}{{end}}{{end}}' "$CADDY")"
[ -n "$CF" ] || { D="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/etc/caddy"}}{{.Source}}{{end}}{{end}}' "$CADDY")"; [ -n "$D" ] && CF="$D/Caddyfile"; }
[ -n "$CF" ] && [ -f "$CF" ] || die "Caddyfile des Containers $CADDY nicht gefunden – App läuft, Caddy bitte von Hand ergänzen (reverse_proxy stunden-prod-app:3000)."
if grep -qE "^[[:space:]]*$(printf '%s' "$HOST" | sed 's/\./\\./g')[[:space:]]*\{" "$CF"; then
  echo "schon vorhanden, unverändert"
else
  BK="/root/Caddyfile.vor-schichtklar24-prod"
  [ -e "$BK" ] || cp -p "$CF" "$BK"
  printf '\n%s {\n\tencode zstd gzip\n\treverse_proxy stunden-prod-app:3000\n}\n' "$HOST" >> "$CF"
  if docker exec "$CADDY" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 \
     && docker exec "$CADDY" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1; then
    echo "ergänzt und neu geladen (Sicherung: $BK)"
  else
    cp -p "$BK" "$CF"
    docker exec "$CADDY" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 || true
    die "Caddy hat den neuen Abschnitt nicht angenommen – alte Datei wiederhergestellt. App läuft intern."
  fi
fi

say "Sicherung mit Wiederherstellungsprobe"
STAGE=prod BACKUP_PASSPHRASE_FILE="$PASS_FILE" bash deploy/sicherung.sh || echo "Hinweis: Sicherung meldet einen Fehler ($STATE/status.txt)."

say "Fertig: https://$HOST läuft mit ${COMMIT:0:12}"
if [ "$FIRST" = 1 ]; then
  cat <<EOF
Nächste Schritte (einmalig):
  1. Ersten Super-Admin anlegen:
     sudo bash $DIR/deploy/prod-bereitstellen.sh --super-admin <deine E-Mail>
  2. Tägliche Sicherung: sudo bash $DIR/deploy/taegliche-sicherung-einrichten.sh prod
  3. In KeePassXC sichern: sudo cat $PASS_FILE ; sudo cat $RESTIC_PASS ; TOTP-Schlüssel aus $DIR/deploy/.env
EOF
fi
}
if [ "${1:-}" = "--super-admin" ]; then super_admin "${2:-}"; else main "$@"; fi
exit
