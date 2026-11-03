#!/usr/bin/env bash
# Builds a release package of exactly one commit for the server, so that the server never has to contact GitHub.
# Runs wherever the code is (development checkout, Arif's PC with Git Bash). The package is three files:
#
#   stundenwerk-<commit12>.bundle          git bundle with the commit and its history (one ref: refs/stundenwerk/paket)
#   stundenwerk-<commit12>.bundle.sha256   checksum, to compare with the value given in the chat
#   stundenwerk-<commit12>.bundle.sig      SSH signature (namespace stundenwerk-paket) – only with --signieren <key>
#
#   deploy/release-paket.sh <commit> [--out <dir>] [--signieren <private-ssh-key>]
#
# Signing can also happen later on another computer (Windows: OpenSSH is built in):
#   ssh-keygen -Y sign -f %USERPROFILE%\.ssh\stundenwerk_paket -n stundenwerk-paket stundenwerk-<commit12>.bundle
# The server only takes packages whose signature matches /etc/stunden-test/paket-signierer
# (installed by deploy/umstellen-ohne-github.sh, import with `stunden-test-paket <file>`).
set -euo pipefail

main() {
COMMIT="${1:-}"
shift || true
OUT="."
KEY=""
while [ $# -gt 0 ]; do
  case "$1" in
    --out) OUT="${2:?--out braucht ein Verzeichnis}"; shift 2 ;;
    --signieren) KEY="${2:?--signieren braucht einen privaten SSH-Schlüssel}"; shift 2 ;;
    *) echo "Unbekannte Option: $1" >&2; exit 2 ;;
  esac
done
[ -n "$COMMIT" ] || { echo "Aufruf: deploy/release-paket.sh <commit> [--out <dir>] [--signieren <schlüssel>]" >&2; exit 2; }

cd "$(dirname "$0")/.."
SHA="$(git rev-parse --verify --quiet "$COMMIT^{commit}")" || { echo "Commit $COMMIT gibt es hier nicht." >&2; exit 1; }
mkdir -p "$OUT"
NAME="stundenwerk-${SHA:0:12}.bundle"
FILE="$OUT/$NAME"

# A dedicated ref, so the bundle names exactly one commit and nothing else from this checkout.
REF=refs/stundenwerk/paket
git update-ref "$REF" "$SHA"
trap 'git update-ref -d "$REF" 2>/dev/null || true' EXIT
git bundle create --quiet "$FILE" "$REF"
git update-ref -d "$REF"
trap - EXIT
git bundle verify --quiet "$FILE"
HEADS="$(git bundle list-heads "$FILE")"
[ "$HEADS" = "$SHA $REF" ] || { echo "Paket enthält nicht genau $SHA: $HEADS" >&2; exit 1; }

( cd "$OUT" && sha256sum "$NAME" > "$NAME.sha256" )
if [ -n "$KEY" ]; then
  rm -f "$FILE.sig"
  ssh-keygen -q -Y sign -f "$KEY" -n stundenwerk-paket "$FILE"
fi

echo "Paket:    $FILE"
echo "Commit:   $SHA"
echo "SHA-256:  $(cut -d' ' -f1 < "$FILE.sha256")"
if [ -f "$FILE.sig" ]; then echo "Signatur: $FILE.sig"; else echo "Signatur: fehlt noch (siehe Kopf dieses Skripts)"; fi
}
main "$@"
exit
