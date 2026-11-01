#!/usr/bin/env bash
# One-time setup of the encrypted off-site copy of the test backups on the Hetzner Storage Box (run with sudo on the
# server). Afterwards deploy/pull-deploy.sh finds /root/.stunden-test-restic.env and sends every backup archive to the
# Storage Box with restic; the restore probe then uses the copy fetched back from there.
#
#   sudo bash storagebox-einrichten.sh <sub-account> <host>
#   sudo bash storagebox-einrichten.sh u704070-sub1 u704070.your-storagebox.de
#
# What it does (idempotent, touches only files named stunden-*):
#   1. installs restic if missing (apt),
#   2. creates the SSH key /root/.ssh/stunden-storagebox (no passphrase, root only) and the host alias
#      "stunden-storagebox" (port 23) in /root/.ssh/config,
#   3. installs the public key on the Storage Box with ssh-copy-id – asks ONCE for the sub-account password,
#      skipped when the key already works,
#   4. creates a random restic password /root/.stunden-test-restic-pass and /root/.stunden-test-restic.env
#      (both root, 600), initialises the repository stundenwerk-test in the sub-account's directory,
#   5. test: backs up the newest local archive, fetches it back and compares the checksum.
# No secret is printed. Copy the two password files into KeePassXC afterwards (see the end of the output):
# without them the backups on the Storage Box cannot be decrypted if the server is lost.
set -euo pipefail

main() {
SUB="${1:-}"
HOST="${2:-}"
die() { printf '\nABBRUCH: %s\n' "$*" >&2; exit 1; }
say() { printf '\n==> %s\n' "$*"; }
[[ "$SUB" =~ ^u[0-9]+(-sub[0-9]+)?$ ]] || die "Aufruf: sudo bash storagebox-einrichten.sh <u123456-sub1> <u123456.your-storagebox.de>"
[[ "$HOST" =~ ^u[0-9]+\.your-storagebox\.de$ ]] || die "Host muss wie u123456.your-storagebox.de aussehen."
[ "$(id -u)" = 0 ] || die "Bitte mit sudo ausführen."

KEY=/root/.ssh/stunden-storagebox
ALIAS=stunden-storagebox
ENV=/root/.stunden-test-restic.env
PASS=/root/.stunden-test-restic-pass
REPO="sftp:$ALIAS:stundenwerk-test"
BDIR=/var/backups/stunden-test

say "restic"
if ! command -v restic >/dev/null; then
  { apt-get update -qq && DEBIAN_FRONTEND=noninteractive apt-get install -y -qq restic; } >/dev/null || die "restic ließ sich nicht installieren."
fi
restic version

say "SSH-Schlüssel und Zugang $ALIAS → $SUB@$HOST:23"
install -d -m 700 /root/.ssh
[ -f "$KEY" ] || ssh-keygen -q -t ed25519 -N '' -C "stunden-test@$(hostname)" -f "$KEY"
chmod 600 "$KEY"
touch /root/.ssh/config && chmod 600 /root/.ssh/config
if ! grep -q "^Host $ALIAS\$" /root/.ssh/config; then
  printf '\nHost %s\n  HostName %s\n  User %s\n  Port 23\n  IdentityFile %s\n  IdentitiesOnly yes\n  ServerAliveInterval 60\n' \
    "$ALIAS" "$HOST" "$SUB" "$KEY" >> /root/.ssh/config
fi
# Host key on first contact (accept-new): shown here, compare with the Hetzner documentation if in doubt.
works() { echo "ls" | sftp -q -b - -o BatchMode=yes -o StrictHostKeyChecking=accept-new "$ALIAS" >/dev/null 2>&1; }
if works; then
  echo "Schlüssel ist schon hinterlegt."
else
  echo "Jetzt EINMAL das Passwort des Sub-Accounts $SUB eingeben (Hetzner Console):"
  ssh-copy-id -s -o StrictHostKeyChecking=accept-new -i "$KEY.pub" "$ALIAS" >/dev/null || die "Schlüssel konnte nicht hinterlegt werden (Passwort? SSH-Support und äußere Erreichbarkeit am Sub-Account an?)."
  works || die "Anmeldung mit Schlüssel klappt noch nicht."
fi
ssh-keygen -l -F "[$HOST]:23" -f /root/.ssh/known_hosts | sed -n '2p' || true
echo "Anmeldung mit Schlüssel: OK"

say "restic-Repository $REPO"
umask 077
[ -s "$PASS" ] || openssl rand -base64 48 | tr -d '\n' > "$PASS"
chmod 600 "$PASS"
printf 'RESTIC_REPOSITORY=%s\nRESTIC_PASSWORD_FILE=%s\n' "$REPO" "$PASS" > "$ENV.tmp"
chmod 600 "$ENV.tmp" && mv "$ENV.tmp" "$ENV"
set -a
# shellcheck disable=SC1090
. "$ENV"
set +a
if restic cat config >/dev/null 2>&1; then
  echo "Repository besteht schon."
else
  restic init >/dev/null && echo "Repository angelegt."
fi

say "Probe: neueste Sicherung hochladen, zurückholen, vergleichen"
# shellcheck disable=SC2012
ARCHIVE="$(ls -t "$BDIR"/*.tar.gpg 2>/dev/null | head -n1 || true)"
[ -n "$ARCHIVE" ] || die "Keine lokale Sicherung in $BDIR gefunden."
FILES=("$ARCHIVE"); [ -f "$ARCHIVE.sha256" ] && FILES+=("$ARCHIVE.sha256")
restic backup --quiet --tag stunden --tag test "${FILES[@]}"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
restic restore latest --tag stunden,test --target "$T" --include "$ARCHIVE" >/dev/null
[ "$(sha256sum < "$ARCHIVE")" = "$(sha256sum < "$T$ARCHIVE")" ] || die "Zurückgeholte Datei weicht ab."
echo "OK: $(basename "$ARCHIVE") liegt verschlüsselt auf der Storage Box und kam unverändert zurück."
restic snapshots --compact | tail -n 4

say "Fertig"
echo "Ab der nächsten Bereitstellung geht jede Sicherung automatisch auch auf die Storage Box."
echo "WICHTIG – zwei Passwörter zusätzlich in KeePassXC sichern (ohne sie sind die Sicherungen nicht lesbar):"
echo "  sudo cat $PASS"
echo "  sudo cat /root/.stunden-test-backup-pass"
echo "(Diese Ausgabe NICHT fotografieren oder in einen Chat kopieren.)"
}
main "$@"
exit
