#!/usr/bin/env bash
# One-time setup of the ISOLATED test environment stunden-test.appzentrale24.de (run once as root on the server).
# Never pipe this into bash from a branch URL. Download it by commit, compare the checksum, read it, then run it
# with the same commit as argument:
#
#   C=<40-stelliger Commit>
#   curl -fsSL -o /root/bootstrap-test.sh "https://raw.githubusercontent.com/A-2026amore/UWE-Stunden-App/$C/deploy/bootstrap-test.sh"
#   sha256sum /root/bootstrap-test.sh && less /root/bootstrap-test.sh
#   bash /root/bootstrap-test.sh "$C"            # optional: CADDY_CONTAINER=<name> bash ... "$C"
#
# What it does (idempotent, touches only stunden-test-*):
#   1. checks Docker, Compose, the external network "proxy" and finds the central Caddy container (read-only),
#   2. clones the repository to /srv/stunden-test and checks out exactly the given commit (detached),
#      creates deploy/.env with random secrets (mode 600) and a backup passphrase in /root/.stunden-test-backup-pass,
#   3. writes the approved commit to /etc/stunden-test/approved-commit and installs /usr/local/sbin/stunden-test-freigeben,
#   4. installs the systemd timer stunden-test-deploy.timer (enabled as the very last step): every 2 minutes it
#      deploys the APPROVED commit if it is not running yet. New commits on GitHub are only reported, never run.
#      A new version runs only after `stunden-test-freigeben <commit>` on the server.
# The central Caddy is NOT changed: the site block and the safe steps to add it are printed at the end.
# No inbound ports are opened; the server only pulls (public repository, no credentials).
set -euo pipefail

# The whole script is one function: a truncated download cannot run half of it.
main() {
REPO_URL="https://github.com/A-2026amore/UWE-Stunden-App.git"
BRANCH="stunden-test-deploy"
DIR="/srv/stunden-test"
HOST="stunden-test.appzentrale24.de"
PASS_FILE="/root/.stunden-test-backup-pass"
CONF_DIR="/etc/stunden-test"

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nABBRUCH: %s\n' "$*" >&2; exit 1; }

COMMIT="${1:-}"
[[ "$COMMIT" =~ ^[0-9a-f]{40}$ ]] || die "Aufruf: bash bootstrap-test.sh <40-stelliger Commit-SHA> (derselbe Commit, von dem dieses Skript geladen wurde)."
[ "$(id -u)" = 0 ] || die "Bitte als root ausführen."
for c in docker git openssl curl systemctl gpg; do command -v "$c" >/dev/null || die "$c fehlt (gpg: apt install gnupg)."; done
docker compose version >/dev/null 2>&1 || die "Docker Compose (Plugin) fehlt."

say "Netz proxy und zentraler Caddy (nur lesen)"
docker network inspect proxy >/dev/null 2>&1 || die "Docker-Netz 'proxy' fehlt (zentraler Caddy?)."
if [ -n "${CADDY_CONTAINER:-}" ]; then
  CADDY="$CADDY_CONTAINER"
  docker inspect "$CADDY" >/dev/null 2>&1 || die "Container $CADDY nicht gefunden."
else
  CANDIDATES="$(docker ps --filter network=proxy --format '{{.Names}} {{.Image}}' | awk 'tolower($2) ~ /caddy/ {print $1}')"
  [ -n "$CANDIDATES" ] || die "Kein laufender Caddy-Container im Netz 'proxy' gefunden."
  [ "$(printf '%s\n' "$CANDIDATES" | wc -l)" = 1 ] \
    || die "Mehrere Caddy-Container im Netz 'proxy': $(echo $CANDIDATES). Bitte mit CADDY_CONTAINER=<name> festlegen."
  CADDY="$CANDIDATES"
fi
CADDY_IP="$(docker inspect -f '{{with index .NetworkSettings.Networks "proxy"}}{{.IPAddress}}{{end}}' "$CADDY")"
[[ "$CADDY_IP" =~ ^[0-9.]+$ ]] || die "Container $CADDY hat keine Adresse im Netz 'proxy'."
echo "Caddy: $CADDY ($CADDY_IP)"

say "Code nach $DIR, fest auf Commit $COMMIT"
if [ -d "$DIR/.git" ]; then
  git -C "$DIR" remote get-url origin | grep -qi 'UWE-Stunden-App' || die "$DIR gehört zu einem anderen Repository."
  [ -z "$(git -C "$DIR" status --porcelain --untracked-files=no)" ] || die "$DIR hat lokale Änderungen – bitte prüfen, nichts verändert."
  git -C "$DIR" fetch --quiet origin
elif [ -e "$DIR" ] && [ -n "$(ls -A "$DIR" 2>/dev/null)" ]; then
  die "$DIR existiert und ist kein Git-Checkout – bitte prüfen, nichts verändert."
else
  git clone --quiet --no-checkout "$REPO_URL" "$DIR"
fi
git -C "$DIR" cat-file -e "$COMMIT^{commit}" 2>/dev/null || die "Commit $COMMIT gibt es im Repository nicht."
git -C "$DIR" -c advice.detachedHead=false checkout --quiet --detach "$COMMIT"
[ "$(git -C "$DIR" rev-parse HEAD)" = "$COMMIT" ] || die "Checkout entspricht nicht $COMMIT."
cd "$DIR"

say "Konfiguration deploy/.env (Geheimnisse nur auf dem Server, Rechte 600)"
umask 077
if [ ! -f deploy/.env ]; then
  # Values go through the environment, not through command-line arguments (not visible in ps).
  V_PG="$(openssl rand -hex 32)" V_APP="$(openssl rand -hex 32)" V_TOTP="$(openssl rand -base64 32)" \
  V_IP="$CADDY_IP" V_HOST="$HOST" awk '
    /^POSTGRES_PASSWORD=/   { print "POSTGRES_PASSWORD=" ENVIRON["V_PG"]; next }
    /^APP_DB_PASSWORD=/     { print "APP_DB_PASSWORD=" ENVIRON["V_APP"]; next }
    /^TOTP_ENCRYPTION_KEY=/ { print "TOTP_ENCRYPTION_KEY=" ENVIRON["V_TOTP"]; next }
    /^TRUSTED_PROXY_IP=/    { print "TRUSTED_PROXY_IP=" ENVIRON["V_IP"]; next }
    /^STAGE=/               { print "STAGE=test"; next }
    /^APP_HOSTNAME=/        { print "APP_HOSTNAME=" ENVIRON["V_HOST"]; next }
    /^APP_IMAGE_TAG=/       { print "APP_IMAGE_TAG=test"; next }
    { print }' deploy/.env.example > deploy/.env.tmp
  mv deploy/.env.tmp deploy/.env
  echo "angelegt"
else
  grep -q '^STAGE=test$' deploy/.env || die "deploy/.env vorhanden, aber nicht STAGE=test – nichts verändert."
  echo "vorhanden, unverändert"
fi
chmod 600 deploy/.env
[ -f "$PASS_FILE" ] || openssl rand -hex 32 > "$PASS_FILE"
chmod 600 "$PASS_FILE"

say "Freigabe: nur Commit $COMMIT"
install -d -m 755 -o root -g root "$CONF_DIR"
printf '%s\n' "$COMMIT" > "$CONF_DIR/approved-commit"
chmod 644 "$CONF_DIR/approved-commit"
umask 022
# The approval helper is written here and never taken from the repository afterwards.
cat > /usr/local/sbin/stunden-test-freigeben <<'EOF'
#!/usr/bin/env bash
# Approves one commit for the test environment stunden-test (installed by deploy/bootstrap-test.sh).
#   stunden-test-freigeben <40-stelliger Commit>   # Commit vorher auf GitHub ansehen
#   stunden-test-freigeben --status
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Bitte als root ausführen." >&2; exit 1; }
F=/etc/stunden-test/approved-commit
if [ "${1:-}" = --status ]; then
  echo "Freigegeben: $(cat "$F")"; echo "Läuft:       $(cat /var/lib/stunden-test/deployed-commit 2>/dev/null || echo -)"
  tail -n 5 /var/lib/stunden-test/status.txt 2>/dev/null || true; exit 0
fi
[[ "${1:-}" =~ ^[0-9a-f]{40}$ ]] || { echo "Aufruf: stunden-test-freigeben <40-stelliger Commit-SHA> | --status" >&2; exit 2; }
git -C /srv/stunden-test fetch --quiet origin
git -C /srv/stunden-test cat-file -e "$1^{commit}" 2>/dev/null || { echo "Commit $1 gibt es im Repository nicht." >&2; exit 1; }
rm -f "/var/lib/stunden-test/failed-$1"
printf '%s\n' "$1" > "$F.tmp" && mv "$F.tmp" "$F"
echo "Freigegeben: $1 – Bereitstellung startet (journalctl -u stunden-test-deploy -f)."
systemctl start --no-block stunden-test-deploy.service
EOF
chmod 755 /usr/local/sbin/stunden-test-freigeben

say "Bereitstellungsdienst (systemd)"
# Entry point of the timer, written here and never taken from the repository: it puts the working tree on the
# approved commit before any script from the repository runs (also after a manual git pull/checkout).
install -d -m 755 /usr/local/lib/stunden-test
cat > /usr/local/lib/stunden-test/deploy-approved <<'EOF'
#!/usr/bin/env bash
# Runs deploy/pull-deploy.sh only from the approved commit (installed by deploy/bootstrap-test.sh).
set -euo pipefail
T="$({ tr -d '[:space:]' < /etc/stunden-test/approved-commit; } 2>/dev/null || true)"
[[ "$T" =~ ^[0-9a-f]{40}$ ]] || { echo "Kein gültiger freigegebener Commit – nichts zu tun."; exit 0; }
cd /srv/stunden-test
if [ "$(git rev-parse HEAD)" != "$T" ]; then
  git fetch --quiet origin
  git -c advice.detachedHead=false checkout --quiet --detach "$T^{commit}"
fi
[ "$(git rev-parse HEAD)" = "$T" ] || { echo "Ausgecheckter Stand ist nicht $T." >&2; exit 1; }
exec /bin/bash deploy/pull-deploy.sh
EOF
chmod 755 /usr/local/lib/stunden-test/deploy-approved
cat > /etc/systemd/system/stunden-test-deploy.service <<EOF
[Unit]
Description=Stundenwerk Testumgebung: freigegebenen Commit bereitstellen
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=$DIR
Environment=BACKUP_PASSPHRASE_FILE=$PASS_FILE
ExecStart=/usr/local/lib/stunden-test/deploy-approved
TimeoutStartSec=1800
NoNewPrivileges=yes
# 022: checked-out files must stay readable for the non-root user in the image; secrets set their own umask.
UMask=0022
EOF
cat > /etc/systemd/system/stunden-test-deploy.timer <<'EOF'
[Unit]
Description=Stundenwerk Testumgebung: alle 2 Minuten freigegebenen Stand prüfen

[Timer]
OnBootSec=2min
OnUnitInactiveSec=2min

[Install]
WantedBy=timers.target
EOF
systemctl daemon-reload
# Last step: from here on the timer runs.
systemctl enable --now stunden-test-deploy.timer >/dev/null

say "Erste Bereitstellung läuft im Hintergrund (ca. 5–10 Minuten)"
echo "Verlauf: journalctl -u stunden-test-deploy -f   ·   Stand: stunden-test-freigeben --status"
echo "Testzugänge entstehen einmalig in /root/stundenwerk-testzugaenge.txt (nur root lesbar)."
echo "Neue Version: Commit auf GitHub prüfen, dann: stunden-test-freigeben <commit>"

say "Caddy wurde NICHT verändert. Einmalig von Hand ergänzen (Container $CADDY):"
cat <<EOF

$HOST {
	encode zstd gzip
	reverse_proxy stunden-test-app:3000
}

Sicherer Ablauf: Caddyfile sichern (cp -p), Block am Ende anfügen,
  docker exec $CADDY caddy validate --config <Pfad im Container> --adapter caddyfile
und nur bei Erfolg
  docker exec $CADDY caddy reload --config <Pfad im Container> --adapter caddyfile
(<Pfad im Container> = die Datei, mit der Caddy tatsächlich gestartet wurde:
  docker inspect -f '{{json .Config.Cmd}}' $CADDY). Bei einem Fehler Sicherung zurückkopieren und erneut reload.
EOF
}
main "$@"
exit
