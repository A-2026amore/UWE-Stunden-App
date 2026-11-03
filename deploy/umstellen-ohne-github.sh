#!/usr/bin/env bash
# One-time switch of the test environment stunden-test to operation WITHOUT GitHub (run once as root on the server,
# after deploy/bootstrap-test.sh). Afterwards the server never contacts GitHub: new versions arrive only as signed
# release packages (deploy/release-paket.sh), copied to the server with scp and imported with `stunden-test-paket`.
# The approval by full commit id (`stunden-test-freigeben <commit>`) stays exactly as before.
#
#   bash umstellen-ohne-github.sh <öffentlicher-ssh-schlüssel.pub> [name]   # name of the signer, default: arif
#   bash umstellen-ohne-github.sh --zurueck                                 # back to GitHub as source
#
# What it does (idempotent, touches only stunden-test-*, no containers are restarted):
#   1. creates the local repository /srv/git/UWE-Stunden-App.git with ONLY the currently approved commit
#      (refs/pakete/<commit> and branch stunden-test-deploy) – no other branch from GitHub is carried over,
#   2. points the checkout /srv/stunden-test to it (remote origin) and drops the GitHub branches there,
#   3. writes the allowed signer to /etc/stunden-test/paket-signierer (namespace stundenwerk-paket),
#   4. installs /usr/local/sbin/stunden-test-paket (check + import a package) and replaces
#      /usr/local/sbin/stunden-test-freigeben with a version that only approves commits from checked packages.
#      The previous version is kept as stunden-test-freigeben.vor-umstellung (for --zurueck).
# The timer stunden-test-deploy and deploy/pull-deploy.sh keep working unchanged: their `git fetch origin` now reads
# the local repository.
set -euo pipefail

main() {
DIR=/srv/stunden-test
BARE=/srv/git/UWE-Stunden-App.git
CONF=/etc/stunden-test
SIGNERS="$CONF/paket-signierer"
STATE=/var/lib/stunden-test
GITHUB_URL="https://github.com/A-2026amore/UWE-Stunden-App.git"
FREIGEBEN=/usr/local/sbin/stunden-test-freigeben

say() { printf '\n==> %s\n' "$*"; }
die() { printf '\nABBRUCH: %s\n' "$*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "Bitte als root ausführen."
[ -d "$DIR/.git" ] || die "$DIR fehlt – zuerst deploy/bootstrap-test.sh."
for c in git ssh-keygen sha256sum; do command -v "$c" >/dev/null || die "$c fehlt."; done

if [ "${1:-}" = --zurueck ]; then
  say "Zurück zu GitHub als Quelle"
  git -C "$DIR" remote set-url origin "$GITHUB_URL"
  git -C "$DIR" fetch --quiet origin || echo "Warnung: GitHub nicht erreichbar – Quelle trotzdem umgestellt."
  [ -f "$FREIGEBEN.vor-umstellung" ] && cp -p "$FREIGEBEN.vor-umstellung" "$FREIGEBEN"
  echo "Fertig. $BARE, $SIGNERS und stunden-test-paket bleiben liegen (schaden nicht)."
  exit 0
fi

PUB="${1:-}"
WHO="${2:-arif}"
{ [ -n "$PUB" ] && [ -f "$PUB" ]; } || die "Aufruf: bash umstellen-ohne-github.sh <öffentlicher-schlüssel.pub> [name]"
[[ "$WHO" =~ ^[a-z][a-z0-9_-]{0,31}$ ]] || die "Name nur aus Kleinbuchstaben/Ziffern: $WHO"
KEYLINE="$(grep -E '^(ssh-ed25519|ecdsa-sha2-nistp256|ssh-rsa) [A-Za-z0-9+/=]+' "$PUB" | head -n1 | awk '{print $1" "$2}' || true)"
[ -n "$KEYLINE" ] || die "$PUB ist kein öffentlicher SSH-Schlüssel (Datei mit .pub, beginnt mit ssh-ed25519)."
printf '%s\n' "$KEYLINE" | ssh-keygen -l -f - >/dev/null 2>&1 || die "$PUB ist kein gültiger Schlüssel."
grep -q 'PRIVATE KEY' "$PUB" && die "$PUB enthält einen PRIVATEN Schlüssel – bitte nur die .pub-Datei verwenden."

APPROVED="$({ tr -d '[:space:]' < "$CONF/approved-commit"; } 2>/dev/null || true)"
[[ "$APPROVED" =~ ^[0-9a-f]{40}$ ]] || die "Kein gültiger freigegebener Commit in $CONF/approved-commit."
git -C "$DIR" cat-file -e "$APPROVED^{commit}" 2>/dev/null || die "Freigegebener Commit fehlt im Checkout."
[ -z "$(git -C "$DIR" status --porcelain --untracked-files=no)" ] || die "$DIR hat lokale Änderungen – nichts verändert."

say "Eigenes Repository $BARE (nur der freigegebene Commit ${APPROVED:0:12})"
if [ ! -d "$BARE" ]; then
  install -d -m 700 -o root -g root /srv/git
  git init --quiet --bare "$BARE"
  # Never run anything on fetch/push in here, never accept pushes.
  git -C "$BARE" config receive.denyNonFastForwards true
  git -C "$BARE" config core.hooksPath /dev/null
fi
git -C "$BARE" fetch --quiet --no-tags "$DIR" "+$APPROVED:refs/pakete/$APPROVED"
git -C "$BARE" update-ref refs/heads/stunden-test-deploy "$APPROVED"
git -C "$BARE" symbolic-ref HEAD refs/heads/stunden-test-deploy

say "Checkout $DIR liest nur noch von dort"
git -C "$DIR" remote set-url origin "$BARE"
git -C "$DIR" fetch --quiet --prune --prune-tags origin
git -C "$DIR" remote get-url origin

say "Erlaubter Paket-Signierer: $WHO"
install -d -m 755 -o root -g root "$CONF"
printf '%s namespaces="stundenwerk-paket" %s\n' "$WHO" "$KEYLINE" > "$SIGNERS.tmp"
chmod 644 "$SIGNERS.tmp" && mv "$SIGNERS.tmp" "$SIGNERS"
printf '%s\n' "$KEYLINE" | ssh-keygen -l -f -
install -d -m 700 -o root -g root "$STATE/eingang" "$STATE/pakete"

say "Werkzeuge stunden-test-paket und stunden-test-freigeben"
# Both are written here and never taken from the repository afterwards.
cat > /usr/local/sbin/stunden-test-paket <<'EOF'
#!/usr/bin/env bash
# Checks and imports a signed release package (installed by deploy/umstellen-ohne-github.sh). No network access.
#   stunden-test-paket /var/lib/stunden-test/eingang/stundenwerk-<commit12>.bundle [--freigeben]
# Expects <datei>.sig (SSH signature, namespace stundenwerk-paket) next to it, <datei>.sha256 optional.
set -euo pipefail
BARE=/srv/git/UWE-Stunden-App.git
SIGNERS=/etc/stunden-test/paket-signierer
STATE=/var/lib/stunden-test
die() { echo "ABBRUCH: $*" >&2; exit 1; }
[ "$(id -u)" = 0 ] || die "Bitte als root ausführen."
F="${1:-}"
FREI=0; [ "${2:-}" = --freigeben ] && FREI=1
{ [ -n "$F" ] && [ -f "$F" ]; } || die "Aufruf: stunden-test-paket <datei.bundle> [--freigeben]"
[ -f "$F.sig" ] || die "Signatur $F.sig fehlt – Paket wird nicht angenommen."
# Work on a private copy: the checked bytes are exactly the imported bytes.
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
cp "$F" "$T/p.bundle"; cp "$F.sig" "$T/p.bundle.sig"
WHO="$(ssh-keygen -Y find-principals -s "$T/p.bundle.sig" -f "$SIGNERS" 2>/dev/null | head -n1 || true)"
[ -n "$WHO" ] || die "Signatur stammt von keinem eingetragenen Schlüssel ($SIGNERS)."
ssh-keygen -Y verify -f "$SIGNERS" -I "$WHO" -n stundenwerk-paket -s "$T/p.bundle.sig" < "$T/p.bundle" >/dev/null 2>&1 \
  || die "Signatur ungültig – Paket verändert oder falscher Schlüssel."
SUM="$(sha256sum "$T/p.bundle" | cut -d' ' -f1)"
if [ -f "$F.sha256" ]; then
  [ "$(cut -d' ' -f1 < "$F.sha256")" = "$SUM" ] || die "Prüfsumme stimmt nicht mit $F.sha256 überein."
fi
HEADS="$(git bundle list-heads "$T/p.bundle")"
[[ "$HEADS" =~ ^([0-9a-f]{40})\ refs/stundenwerk/paket$ ]] || die "Paket muss genau einen Commit (refs/stundenwerk/paket) enthalten."
SHA="${BASH_REMATCH[1]}"
git -C "$BARE" bundle verify --quiet "$T/p.bundle" >/dev/null 2>&1 || die "Paket unvollständig (git bundle verify)."
git -C "$BARE" fetch --quiet --no-tags "$T/p.bundle" "+refs/stundenwerk/paket:refs/pakete/$SHA"
[ "$(git -C "$BARE" rev-parse "refs/pakete/$SHA")" = "$SHA" ] || die "Import fehlgeschlagen."
git -C "$BARE" update-ref refs/heads/stunden-test-deploy "$SHA"
git -C /srv/stunden-test fetch --quiet origin
NAME="stundenwerk-${SHA:0:12}.bundle"
cp "$T/p.bundle" "$STATE/pakete/$NAME"; cp "$T/p.bundle.sig" "$STATE/pakete/$NAME.sig"
printf '%s %s signiert-von=%s sha256=%s\n' "$(date -Is)" "$SHA" "$WHO" "$SUM" >> "$STATE/pakete.txt"
# Copy of the package on the Hetzner Storage Box, if restic is set up for the backups.
R=/root/.stunden-test-restic.env
if [ -f "$R" ] && [ "$(stat -c '%u %a' "$R")" = "0 600" ] && command -v restic >/dev/null; then
  # shellcheck disable=SC1090
  ( set -a; . "$R"; set +a; restic backup --quiet --tag stunden --tag paket "$STATE/pakete/$NAME" "$STATE/pakete/$NAME.sig" ) \
    && echo "Kopie auf der Storage Box abgelegt." || echo "Warnung: Kopie auf die Storage Box fehlgeschlagen (Paket ist trotzdem importiert)."
fi
echo "Paket geprüft und übernommen: Commit $SHA (signiert von $WHO, SHA-256 $SUM)"
if [ "$FREI" = 1 ]; then exec /usr/local/sbin/stunden-test-freigeben "$SHA"; fi
echo "Freigeben mit: stunden-test-freigeben $SHA"
EOF
chmod 755 /usr/local/sbin/stunden-test-paket

[ -f "$FREIGEBEN.vor-umstellung" ] || cp -p "$FREIGEBEN" "$FREIGEBEN.vor-umstellung"
cat > "$FREIGEBEN.tmp" <<'EOF'
#!/usr/bin/env bash
# Approves one commit for the test environment stunden-test (deploy/umstellen-ohne-github.sh: without GitHub).
# Only commits that arrived in a checked, signed package (stunden-test-paket) can be approved.
#   stunden-test-freigeben <40-stelliger Commit>
#   stunden-test-freigeben --status
set -euo pipefail
[ "$(id -u)" = 0 ] || { echo "Bitte als root ausführen." >&2; exit 1; }
F=/etc/stunden-test/approved-commit
BARE=/srv/git/UWE-Stunden-App.git
if [ "${1:-}" = --status ]; then
  echo "Freigegeben: $(cat "$F")"; echo "Läuft:       $(cat /var/lib/stunden-test/deployed-commit 2>/dev/null || echo -)"
  echo "Quelle:      $(git -C /srv/stunden-test remote get-url origin)"
  echo "Letzte Pakete:"; tail -n 3 /var/lib/stunden-test/pakete.txt 2>/dev/null || echo "  -"
  tail -n 5 /var/lib/stunden-test/status.txt 2>/dev/null || true; exit 0
fi
[[ "${1:-}" =~ ^[0-9a-f]{40}$ ]] || { echo "Aufruf: stunden-test-freigeben <40-stelliger Commit-SHA> | --status" >&2; exit 2; }
git -C "$BARE" show-ref --verify --quiet "refs/pakete/$1" \
  || { echo "Commit $1 kam in keinem geprüften Paket an. Zuerst: stunden-test-paket <datei.bundle>" >&2; exit 1; }
git -C /srv/stunden-test fetch --quiet origin
git -C /srv/stunden-test cat-file -e "$1^{commit}" 2>/dev/null || { echo "Commit $1 fehlt im Checkout." >&2; exit 1; }
rm -f "/var/lib/stunden-test/failed-$1"
printf '%s\n' "$1" > "$F.tmp" && mv "$F.tmp" "$F"
echo "Freigegeben: $1 – Bereitstellung startet (journalctl -u stunden-test-deploy -f)."
systemctl start --no-block stunden-test-deploy.service
EOF
chmod 755 "$FREIGEBEN.tmp" && mv "$FREIGEBEN.tmp" "$FREIGEBEN"

say "Fertig – der Server holt ab jetzt nichts mehr von GitHub"
echo "Neue Version: Paket + .sig nach $STATE/eingang/ kopieren (scp), dann"
echo "  stunden-test-paket $STATE/eingang/stundenwerk-<commit12>.bundle --freigeben"
echo "Stand: stunden-test-freigeben --status   ·   Rückweg: bash umstellen-ohne-github.sh --zurueck"
}
main "$@"
exit
