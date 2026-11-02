#!/usr/bin/env bash
# One-time setup of the DAILY backup of the test environment (run with sudo on the server):
#
#   sudo bash /srv/stunden-test/deploy/taegliche-sicherung-einrichten.sh
#
# Installs stunden-test-backup.timer: every night at 03:30 (missed runs are caught up after a reboot) it runs
# deploy/sicherung.sh – encrypted backup, copy to the Storage Box (if set up), restore probe – exactly like after a
# deployment. The entry point is written here, not taken from the repository: it only runs when the working tree is
# the approved and deployed commit, and it waits for a running deployment (shared lock /run/stunden-test.lock).
# Idempotent; touches only files named stunden-test-backup*. Undo:
#   systemctl disable --now stunden-test-backup.timer
#
# For tests: STUNDEN_ROOT=<dir> writes everything below <dir> and skips systemctl.
set -euo pipefail

main() {
R="${STUNDEN_ROOT:-}"
die() { printf '\nABBRUCH: %s\n' "$*" >&2; exit 1; }
[ -n "$R" ] || [ "$(id -u)" = 0 ] || die "Bitte mit sudo ausführen."
DIR=/srv/stunden-test
PASS_FILE=/root/.stunden-test-backup-pass
if [ -z "$R" ]; then
  [ -d "$DIR/.git" ] || die "$DIR ist keine Installation der Testumgebung."
  [ -s "$PASS_FILE" ] || die "$PASS_FILE fehlt – die Sicherung wäre nicht verschlüsselt."
fi

install -d -m 755 "$R/usr/local/lib/stunden-test" "$R/etc/systemd/system"
cat > "$R/usr/local/lib/stunden-test/daily-backup" <<'ENTRY'
#!/usr/bin/env bash
# Daily backup of the test environment (installed by deploy/taegliche-sicherung-einrichten.sh).
set -euo pipefail
ROOT="${STUNDEN_ROOT:-}"
exec 9>"$ROOT/run/stunden-test.lock"
flock 9
T="$({ tr -d '[:space:]' < "$ROOT/etc/stunden-test/approved-commit"; } 2>/dev/null || true)"
[[ "$T" =~ ^[0-9a-f]{40}$ ]] || { echo "Kein gültiger freigegebener Commit – keine Sicherung."; exit 1; }
D="$({ tr -d '[:space:]' < "$ROOT/var/lib/stunden-test/deployed-commit"; } 2>/dev/null || true)"
[ "$D" = "$T" ] || { echo "Freigegebener Stand ist noch nicht bereitgestellt – Sicherung folgt nach der Bereitstellung."; exit 0; }
cd "${STUNDEN_DIR:-/srv/stunden-test}"
[ "$(git rev-parse HEAD)" = "$T" ] || { echo "Ausgecheckter Stand ist nicht $T – keine Sicherung." >&2; exit 1; }
exec /bin/bash deploy/sicherung.sh
ENTRY
chmod 755 "$R/usr/local/lib/stunden-test/daily-backup"

cat > "$R/etc/systemd/system/stunden-test-backup.service" <<UNIT
[Unit]
Description=Stundenwerk Testumgebung: tägliche Sicherung mit Wiederherstellungsprobe
After=docker.service network-online.target
Wants=network-online.target

[Service]
Type=oneshot
WorkingDirectory=$DIR
Environment=BACKUP_PASSPHRASE_FILE=$PASS_FILE
ExecStart=/usr/local/lib/stunden-test/daily-backup
TimeoutStartSec=3600
NoNewPrivileges=yes
# 022 like the deployment service: backup.sh and restore-test.sh set their own umask for secrets.
UMask=0022
UNIT

cat > "$R/etc/systemd/system/stunden-test-backup.timer" <<'UNIT'
[Unit]
Description=Stundenwerk Testumgebung: Sicherung jede Nacht um 03:30

[Timer]
OnCalendar=*-*-* 03:30:00
Persistent=true
RandomizedDelaySec=10min

[Install]
WantedBy=timers.target
UNIT

if [ -z "$R" ]; then
  systemctl daemon-reload
  systemctl enable --now stunden-test-backup.timer >/dev/null
  echo "Tägliche Sicherung eingerichtet. Nächster Lauf:"
  systemctl list-timers stunden-test-backup.timer --no-pager | sed -n '1,2p'
  echo "Sofort einmal testen: sudo systemctl start stunden-test-backup.service && sudo stunden-test-freigeben --status"
else
  echo "Dateien unter $R geschrieben (Testmodus, kein systemctl)."
fi
}
main "$@"
exit
