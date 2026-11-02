#!/usr/bin/env bash
# One-time setup of the DAILY backup of an environment (run with sudo on the server):
#
#   sudo bash /srv/stunden-test/deploy/taegliche-sicherung-einrichten.sh          # Testumgebung, 03:30
#   sudo bash /srv/stunden-prod/deploy/taegliche-sicherung-einrichten.sh prod     # echte Umgebung, 02:30
#
# Installs stunden-<stage>-backup.timer: every night at 03:30 (test) / 02:30 (prod) (missed runs are caught up after a reboot) it runs
# deploy/sicherung.sh – encrypted backup, copy to the Storage Box (if set up), restore probe – exactly like after a
# deployment. The entry point is written here, not taken from the repository: it only runs when the working tree is
# the approved and deployed commit, and it waits for a running deployment (shared lock /run/stunden-<stage>.lock).
# Idempotent; touches only files named stunden-<stage>-backup*. Undo:
#   systemctl disable --now stunden-<stage>-backup.timer
#
# For tests: STUNDEN_ROOT=<dir> writes everything below <dir> and skips systemctl.
set -euo pipefail

main() {
R="${STUNDEN_ROOT:-}"
STAGE="${1:-test}"
case "$STAGE" in test) AT="03:30:00" ;; prod) AT="02:30:00" ;; *) echo "Aufruf: … [test|prod]" >&2; exit 2 ;; esac
die() { printf '\nABBRUCH: %s\n' "$*" >&2; exit 1; }
[ -n "$R" ] || [ "$(id -u)" = 0 ] || die "Bitte mit sudo ausführen."
DIR="/srv/stunden-$STAGE"
PASS_FILE="/root/.stunden-$STAGE-backup-pass"
UNIT="stunden-$STAGE-backup"
ENTRY="/usr/local/lib/stunden-$STAGE/daily-backup"
if [ -z "$R" ]; then
  [ -d "$DIR/.git" ] || die "$DIR ist keine Installation ($STAGE)."
  [ -s "$PASS_FILE" ] || die "$PASS_FILE fehlt – die Sicherung wäre nicht verschlüsselt."
fi

install -d -m 755 "$R/usr/local/lib/stunden-$STAGE" "$R/etc/systemd/system"
{ printf '#!/usr/bin/env bash\n# Daily backup (installed by deploy/taegliche-sicherung-einrichten.sh).\nSTAGE=%s\n' "$STAGE"
  cat <<'ENTRY'
set -euo pipefail
export STAGE
ROOT="${STUNDEN_ROOT:-}"
exec 9>"$ROOT/run/stunden-$STAGE.lock"
flock 9
T="$({ tr -d '[:space:]' < "$ROOT/etc/stunden-$STAGE/approved-commit"; } 2>/dev/null || true)"
[[ "$T" =~ ^[0-9a-f]{40}$ ]] || { echo "Kein gültiger freigegebener Commit – keine Sicherung."; exit 1; }
D="$({ tr -d '[:space:]' < "$ROOT/var/lib/stunden-$STAGE/deployed-commit"; } 2>/dev/null || true)"
[ "$D" = "$T" ] || { echo "Freigegebener Stand ist noch nicht bereitgestellt – Sicherung folgt nach der Bereitstellung."; exit 0; }
cd "${STUNDEN_DIR:-/srv/stunden-$STAGE}"
[ "$(git rev-parse HEAD)" = "$T" ] || { echo "Ausgecheckter Stand ist nicht $T – keine Sicherung." >&2; exit 1; }
exec /bin/bash deploy/sicherung.sh
ENTRY
} > "$R$ENTRY"
chmod 755 "$R$ENTRY"

cat > "$R/etc/systemd/system/$UNIT.service" <<UNIT
[Unit]
Description=Schichtklar24 ($STAGE): tägliche Sicherung mit Wiederherstellungsprobe
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=$DIR
Environment=BACKUP_PASSPHRASE_FILE=$PASS_FILE
ExecStart=$ENTRY
TimeoutStartSec=3600
NoNewPrivileges=yes
# 022 like the deployment service: backup.sh and restore-test.sh set their own umask for secrets.
UMask=0022
UNIT

cat > "$R/etc/systemd/system/$UNIT.timer" <<UNIT
[Unit]
Description=Schichtklar24 ($STAGE): Sicherung jede Nacht um $AT

[Timer]
OnCalendar=*-*-* $AT
Persistent=true
RandomizedDelaySec=10min

[Install]
WantedBy=timers.target
UNIT

if [ -z "$R" ]; then
  systemctl daemon-reload
  systemctl enable --now "$UNIT.timer" >/dev/null
  echo "Tägliche Sicherung eingerichtet. Nächster Lauf:"
  systemctl list-timers "$UNIT.timer" --no-pager | sed -n '1,2p'
  echo "Sofort einmal testen: sudo systemctl start $UNIT.service && sudo tail -n 3 /var/lib/stunden-$STAGE/status.txt"
else
  echo "Dateien unter $R geschrieben (Testmodus, kein systemctl)."
fi
}
main "$@"
exit
