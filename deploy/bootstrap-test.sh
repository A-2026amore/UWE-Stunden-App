#!/usr/bin/env bash
# One-time setup of the ISOLATED test environment stunden-test.appzentrale24.de (run once as root on the server):
#
#   curl -fsSL https://raw.githubusercontent.com/A-2026amore/UWE-Stunden-App/stunden-test-deploy/deploy/bootstrap-test.sh | bash
#
# What it does (idempotent, touches only stunden-test-*):
#   1. checks Docker, Compose, the external network "proxy" and the central Caddy container,
#   2. clones the repository to /srv/stunden-test (branch stunden-test-deploy), creates deploy/.env with random
#      secrets (mode 600) and a backup passphrase in /root/.stunden-test-backup-pass (mode 600),
#   3. installs the systemd timer stunden-test-deploy.timer: every 2 minutes the server pulls the branch
#      stunden-test-deploy from GitHub (read-only, no credentials) and, when it changed, runs
#      deploy/pull-deploy.sh (backup, build, migrate, restart, health check, test accounts once),
#   4. adds the site block for stunden-test.appzentrale24.de to the central Caddyfile (backup copy, validate,
#      graceful reload; on any error the old file is restored),
#   5. starts the first deployment in the background (log: journalctl -u stunden-test-deploy -f).
# Nothing else on the server is changed. No inbound ports are opened; the server only pulls.
set -euo pipefail

REPO_URL="https://github.com/A-2026amore/UWE-Stunden-App.git"
BRANCH="stunden-test-deploy"
DIR="/srv/stunden-test"
HOST="stunden-test.appzentrale24.de"
PASS_FILE="/root/.stunden-test-backup-pass"

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nABBRUCH: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "Bitte als root ausführen."
for c in docker git openssl curl systemctl; do command -v "$c" >/dev/null || die "$c fehlt."; done
docker compose version >/dev/null 2>&1 || die "Docker Compose (Plugin) fehlt."

say "Netz proxy und zentraler Caddy"
docker network inspect proxy >/dev/null 2>&1 || die "Docker-Netz 'proxy' fehlt (zentraler Caddy?)."
CADDY="$(docker ps --filter network=proxy --format '{{.Names}} {{.Image}}' | awk 'tolower($2) ~ /caddy/ {print $1; exit}')"
[ -n "$CADDY" ] || die "Kein laufender Caddy-Container im Netz 'proxy' gefunden."
CADDY_IP="$(docker inspect -f '{{(index .NetworkSettings.Networks "proxy").IPAddress}}' "$CADDY")"
echo "Caddy: $CADDY ($CADDY_IP)"

say "Code nach $DIR"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" remote get-url origin | grep -qi 'UWE-Stunden-App' || die "$DIR gehört zu einem anderen Repository."
  git -C "$DIR" fetch --quiet origin "$BRANCH"
  git -C "$DIR" checkout --quiet -B "$BRANCH" "origin/$BRANCH"
elif [ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
  die "$DIR existiert und ist kein Git-Checkout – bitte prüfen, nichts verändert."
else
  git clone --quiet --branch "$BRANCH" "$REPO_URL" "$DIR"
fi
cd "$DIR"

say "Konfiguration deploy/.env (Geheimnisse nur auf dem Server, Rechte 600)"
umask 077
if [ ! -f deploy/.env ]; then
  sed -e "s/^POSTGRES_PASSWORD=.*/POSTGRES_PASSWORD=$(openssl rand -hex 32)/" \
      -e "s/^APP_DB_PASSWORD=.*/APP_DB_PASSWORD=$(openssl rand -hex 32)/" \
      -e "s#^TOTP_ENCRYPTION_KEY=.*#TOTP_ENCRYPTION_KEY=$(openssl rand -base64 32)#" \
      -e "s/^TRUSTED_PROXY_IP=.*/TRUSTED_PROXY_IP=$CADDY_IP/" \
      -e "s/^STAGE=.*/STAGE=test/" -e "s/^APP_HOSTNAME=.*/APP_HOSTNAME=$HOST/" \
      deploy/.env.example > deploy/.env
  echo "angelegt"
else
  grep -q '^STAGE=test$' deploy/.env || die "deploy/.env vorhanden, aber nicht STAGE=test – nichts verändert."
  echo "vorhanden, unverändert"
fi
chmod 600 deploy/.env
[ -f "$PASS_FILE" ] || openssl rand -hex 32 > "$PASS_FILE"
chmod 600 "$PASS_FILE"
umask 022

say "Automatische Bereitstellung (systemd)"
cat > /etc/systemd/system/stunden-test-deploy.service <<EOF
[Unit]
Description=Stundenwerk Testumgebung: Stand $BRANCH holen und bereitstellen
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=$DIR
Environment=BACKUP_PASSPHRASE_FILE=$PASS_FILE
ExecStart=/bin/bash $DIR/deploy/pull-deploy.sh
TimeoutStartSec=1800
EOF
cat > /etc/systemd/system/stunden-test-deploy.timer <<'EOF'
[Unit]
Description=Stundenwerk Testumgebung: alle 2 Minuten auf neuen Stand prüfen

[Timer]
OnBootSec=2min
OnUnitInactiveSec=2min

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
systemctl enable --now stunden-test-deploy.timer >/dev/null

say "Caddy: Seite $HOST"
CF_HOST="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/etc/caddy/Caddyfile"}}{{.Source}}{{end}}{{end}}' "$CADDY")"
if [ -z "$CF_HOST" ]; then
  CF_DIR="$(docker inspect -f '{{range .Mounts}}{{if eq .Destination "/etc/caddy"}}{{.Source}}{{end}}{{end}}' "$CADDY")"
  [ -n "$CF_DIR" ] && CF_HOST="$CF_DIR/Caddyfile"
fi
if [ -z "$CF_HOST" ] || [ ! -f "$CF_HOST" ]; then
  echo "WARNUNG: Caddyfile des Containers $CADDY nicht gefunden – Caddy bitte manuell ergänzen (deploy/README.md)."
elif grep -q "^$HOST" "$CF_HOST"; then
  echo "Eintrag vorhanden, unverändert ($CF_HOST)"
else
  BAK="$CF_HOST.bak-stunden-test-$(date +%Y%m%d%H%M%S)"
  cp -p "$CF_HOST" "$BAK"
  printf '\n# Stundenwerk Testumgebung (deploy/bootstrap-test.sh)\n%s {\n\tencode zstd gzip\n\treverse_proxy stunden-test-app:3000\n}\n' "$HOST" >> "$CF_HOST"
  if docker exec "$CADDY" caddy validate --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1 \
     && docker exec "$CADDY" caddy reload --config /etc/caddy/Caddyfile --adapter caddyfile >/dev/null 2>&1; then
    echo "ergänzt und neu geladen (Sicherung: $BAK)"
  else
    cp -p "$BAK" "$CF_HOST"
    echo "WARNUNG: Caddy lehnte die Ergänzung ab – alte Datei wiederhergestellt. Bitte manuell prüfen (deploy/README.md)."
  fi
fi

say "Erste Bereitstellung läuft im Hintergrund (ca. 5–10 Minuten)"
systemctl start --no-block stunden-test-deploy.service
echo "Verlauf: journalctl -u stunden-test-deploy -f"
echo "Testzugänge entstehen einmalig in /root/stundenwerk-testzugaenge.txt (nur root lesbar)."
echo "Fertig. Weitere Aktualisierungen kommen automatisch über den Branch $BRANCH."
