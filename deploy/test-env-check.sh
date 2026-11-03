#!/usr/bin/env bash
# Checks the public test environment after an approval, WITHOUT GitHub Actions (same checks as
# .github/workflows/test-env-check.yml). Runs on the server or any computer with curl; the browser part needs Docker.
#
#   deploy/test-env-check.sh [<commit>] [--ohne-browser]
#
# <commit>: waits (max. 35 min) until /api/health reports it. Only public HTTPS requests, no accounts, no secrets.
set -euo pipefail

main() {
URL="${URL:-https://stunden-test.appzentrale24.de}"
WANT=""
BROWSER=1
for a in "$@"; do
  case "$a" in
    --ohne-browser) BROWSER=0 ;;
    *) [[ "$a" =~ ^[0-9a-f]{7,40}$ ]] || { echo "Unbekanntes Argument: $a" >&2; exit 2; }; WANT="$a" ;;
  esac
done
fail() { echo "FEHLER: $*" >&2; exit 1; }
code() { curl -s -o /dev/null -w '%{http_code}' "$@"; }

if [ -n "$WANT" ]; then
  echo "Warte auf Stand $WANT …"
  for i in $(seq 1 70); do
    got="$(curl -fsS --max-time 10 "$URL/api/health" 2>/dev/null | sed -n 's/.*"commit":"\([0-9a-f]*\)".*/\1/p' || true)"
    if [ -n "$got" ] && { [ "${WANT#"$got"}" != "$WANT" ] || [ "${got#"$WANT"}" != "$got" ]; }; then echo "Ausgerollt: $got"; break; fi
    [ "$i" = 70 ] && fail "nach 35 Minuten nicht ausgerollt (zuletzt: ${got:-keine Antwort})"
    sleep 30
  done
fi

echo "HTTPS und Sicherheits-Header"
curl -fsS -o /dev/null "$URL/" || fail "$URL/ nicht erreichbar oder Zertifikat ungültig"
[ "$(code "http://${URL#https://}/")" -ge 300 ] || fail "keine Weiterleitung von http"
h="$(curl -fsSI "$URL/app/")"
for hdr in '^strict-transport-security:' '^content-security-policy:' '^x-content-type-options: nosniff'; do
  echo "$h" | grep -qi "$hdr" || fail "Header fehlt: $hdr"
done
for p in / /app/ /chef/ /admin/ /app/manifest.webmanifest; do
  [ "$(code "$URL$p")" = 200 ] || fail "$p liefert nicht 200"
done
[ "$(curl -fsS "$URL/api/auth/session")" = "null" ] || fail "/api/auth/session ohne Sitzung nicht null"
[ "$(code "$URL/api/employees/3f6c2a1e-8b4d-4c7a-9e21-5d0b7f9a4c13/time-entries?month=2026-10")" = 401 ] || fail "geschützte Daten nicht 401"
[ "$(code -X POST -H 'Origin: https://angreifer.example' -H 'Content-Type: application/json' \
      --data '{"email":"x@example.com","password":"x"}' "$URL/api/auth/login")" = 403 ] || fail "fremde Herkunft nicht abgewiesen"
echo "OK: HTTPS, Header, Schnittstellen"

[ "$BROWSER" = 1 ] || exit 0
command -v docker >/dev/null || { echo "Hinweis: Docker fehlt – Browserprüfung übersprungen."; exit 0; }
echo "Anmeldeseiten im Browser (Chromium und WebKit)"
cd "$(dirname "$0")/.."
IMAGE="${PRUEFEN_IMAGE:-mcr.microsoft.com/playwright:v1.63.0-noble}"
tar -c package.json package-lock.json scripts/check-test-env.mjs | docker run --rm -i --cpus 2 --memory 2g \
  --security-opt no-new-privileges -e URL="$URL" "$IMAGE" bash -euo pipefail -c '
    mkdir /w && tar -x -C /w && cd /w && npm ci --ignore-scripts --no-audit --no-fund >/dev/null && node scripts/check-test-env.mjs'
echo "OK: Testumgebung geprüft"
}
main "$@"
