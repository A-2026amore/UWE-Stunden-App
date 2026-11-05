#!/usr/bin/env bash
# One-time setup of the Caddy watchdog (run with sudo on the server):
#
#   sudo bash /srv/stunden-test/deploy/caddy-waechter-einrichten.sh
#
# Background (incident 05.11.2026): the central Caddy has a fixed address in the shared network "proxy"
# (172.30.0.2, see deploy/README.md, TRUSTED_PROXY_IP). Containers without a fixed address get any free one. After a
# reboot an app container started first, received 172.30.0.2, and Caddy could not start ("Address already in use") –
# all sites on the server were unreachable until it was fixed by hand.
#
# The watchdog (systemd timer: 1 minute after boot, then every 2 minutes) does nothing while Caddy runs. When Caddy is
# not running it looks up Caddy's fixed address; if another container holds it, that container is taken out of the
# network "proxy" for a moment, Caddy is started, and the container is connected again (it gets another free address;
# it keeps running, nothing is restarted). Otherwise Caddy is simply started. Every action goes to the journal:
#   journalctl -t caddy-waechter
# Idempotent; touches only files named caddy-waechter*. Undo:
#   systemctl disable --now caddy-waechter.timer
#
# Options (environment): CADDY_CONTAINER (default proxy-caddy-1), PROXY_NETWORK (default proxy).
# For tests: STUNDEN_ROOT=<dir> writes everything below <dir> and skips systemctl.
set -euo pipefail

main() {
R="${STUNDEN_ROOT:-}"
die() { printf '\nABBRUCH: %s\n' "$*" >&2; exit 1; }
[ -n "$R" ] || [ "$(id -u)" = 0 ] || die "Bitte mit sudo ausführen."
CADDY="${CADDY_CONTAINER:-proxy-caddy-1}"
NET="${PROXY_NETWORK:-proxy}"
[[ "$CADDY" =~ ^[A-Za-z0-9_.-]+$ ]] || die "CADDY_CONTAINER ungültig: $CADDY"
[[ "$NET" =~ ^[A-Za-z0-9_.-]+$ ]] || die "PROXY_NETWORK ungültig: $NET"
if [ -z "$R" ]; then
  docker inspect "$CADDY" >/dev/null 2>&1 || die "Container $CADDY gibt es nicht – bitte CADDY_CONTAINER=<name> setzen."
fi

ENTRY="$R/usr/local/lib/caddy-waechter/pruefen"
install -d -m 755 "$R/usr/local/lib/caddy-waechter" "$R/etc/systemd/system"
{ printf '#!/usr/bin/env bash\n# Caddy watchdog (installed by deploy/caddy-waechter-einrichten.sh).\nCADDY=%s\nNET=%s\n' "$CADDY" "$NET"
  cat <<'ENTRY'
set -uo pipefail
DOCKER="${DOCKER:-docker}"
log() { if command -v logger >/dev/null 2>&1 && [ -z "${STUNDEN_ROOT:-}" ]; then logger -t caddy-waechter -- "$*"; fi; echo "$*"; }

[ "$("$DOCKER" inspect -f '{{.State.Running}}' "$CADDY" 2>/dev/null)" = "true" ] && exit 0

WANT="$("$DOCKER" inspect -f "{{with index .NetworkSettings.Networks \"$NET\"}}{{with .IPAMConfig}}{{.IPv4Address}}{{end}}{{end}}" "$CADDY" 2>/dev/null)"
HOLDER=""
if [[ "$WANT" =~ ^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  HOLDER="$("$DOCKER" network inspect "$NET" -f '{{range .Containers}}{{.Name}} {{.IPv4Address}}{{"\n"}}{{end}}' 2>/dev/null \
    | awk -v ip="$WANT/" -v self="$CADDY" 'index($2, ip) == 1 && $1 != self { print $1; exit }')"
fi

if [ -n "$HOLDER" ]; then
  log "$CADDY läuft nicht; seine Adresse $WANT ist von $HOLDER belegt – $HOLDER kurz aus Netz $NET, $CADDY starten, wieder verbinden."
  "$DOCKER" network disconnect "$NET" "$HOLDER" || log "Trennen von $HOLDER fehlgeschlagen."
  "$DOCKER" start "$CADDY" || log "Start von $CADDY fehlgeschlagen."
  "$DOCKER" network connect "$NET" "$HOLDER" || log "FEHLER: $HOLDER konnte nicht wieder mit $NET verbunden werden."
else
  log "$CADDY läuft nicht – starten."
  "$DOCKER" start "$CADDY" || log "Start von $CADDY fehlgeschlagen."
fi
if [ "$("$DOCKER" inspect -f '{{.State.Running}}' "$CADDY" 2>/dev/null)" = "true" ]; then
  log "OK: $CADDY läuft wieder."
else
  log "FEHLER: $CADDY läuft weiterhin nicht."
  exit 1
fi
ENTRY
} > "$ENTRY.neu"
chmod 755 "$ENTRY.neu"
mv "$ENTRY.neu" "$ENTRY"

cat > "$R/etc/systemd/system/caddy-waechter.service" <<UNIT
[Unit]
Description=Caddy-Wächter: zentralen Webserver starten, falls er nicht läuft
After=docker.service
Requires=docker.service

[Service]
Type=oneshot
ExecStart=/usr/local/lib/caddy-waechter/pruefen
UNIT

cat > "$R/etc/systemd/system/caddy-waechter.timer" <<'UNIT'
[Unit]
Description=Caddy-Wächter: 1 Minute nach dem Start, dann alle 2 Minuten

[Timer]
OnBootSec=1min
OnUnitActiveSec=2min
AccuracySec=15s

[Install]
WantedBy=timers.target
UNIT

if [ -z "$R" ]; then
  systemctl daemon-reload
  systemctl enable --now caddy-waechter.timer >/dev/null
  systemctl start caddy-waechter.service || true
  echo "Caddy-Wächter eingerichtet (Container $CADDY, Netz $NET)."
  systemctl list-timers caddy-waechter.timer --no-pager | head -n 3
  echo "Protokoll: journalctl -t caddy-waechter"
else
  echo "Caddy-Wächter geschrieben nach $R (Testmodus)."
fi
}

main "$@"
