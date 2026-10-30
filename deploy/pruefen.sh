#!/usr/bin/env bash
# Runs the automatic checks of one commit WITHOUT GitHub Actions, in a throwaway container (Docker only).
# Same checks as .github/workflows/ci.yml: lint, typecheck, unit tests, build, database/RLS and server tests,
# optionally the browser tests. Usable on the server before an approval and on any computer with Docker.
#
#   deploy/pruefen.sh <commit>            # lint, typecheck, unit, build, database (approx. 5–10 min)
#   deploy/pruefen.sh <commit> --voll     # additionally browser tests (Chromium, Android, iPhone-WebKit) and full stack
#   deploy/pruefen.sh <commit> --schnell  # only lint, typecheck, unit, build
#
# The code of the commit is streamed into the container with `git archive` (nothing is written to the checkout).
# The container gets at most 2 CPUs and 4 GB RAM, no ports, no host directories and no secrets; it needs internet
# access to the npm and Ubuntu package mirrors. Not covered here: the container job (the server's own deployment
# builds the image, migrates, checks health, backs up and runs the restore probe) and the secret scan (gitleaks).
set -euo pipefail

main() {
COMMIT="${1:-}"
MODE="${2:-standard}"
case "$MODE" in standard|--voll|--schnell) ;; *) echo "Unbekannte Option: $MODE" >&2; exit 2 ;; esac
[ -n "$COMMIT" ] || { echo "Aufruf: deploy/pruefen.sh <commit> [--voll|--schnell]" >&2; exit 2; }
cd "$(dirname "$0")/.."
SHA="$(git rev-parse --verify --quiet "$COMMIT^{commit}")" || { echo "Commit $COMMIT gibt es hier nicht." >&2; exit 1; }
command -v docker >/dev/null || { echo "Docker fehlt." >&2; exit 1; }

# Same Playwright version as package-lock.json; the image brings Node, Chromium and WebKit with their libraries.
IMAGE="${PRUEFEN_IMAGE:-mcr.microsoft.com/playwright:v1.63.0-noble}"
LOG_DIR=/var/lib/stunden-test
[ -w "$LOG_DIR" ] || LOG_DIR="${TMPDIR:-/tmp}"
LOG="$LOG_DIR/pruefung-${SHA:0:12}.log"

# Extra docker run options only for unusual networks (e.g. a company proxy CA), never needed on the server.
read -r -a EXTRA <<< "${PRUEFEN_DOCKER_ARGS:-}"

echo "Prüfe ${SHA:0:12} ($MODE) – Protokoll: $LOG"
set +e
git archive --format=tar "$SHA" | docker run --rm -i --name "stunden-pruefen-${SHA:0:12}" "${EXTRA[@]}" \
  --cpus 2 --memory 4g --pids-limit 4096 --shm-size 1g --security-opt no-new-privileges \
  -e CI=1 -e MODE="$MODE" -e APP_COMMIT="$SHA" "$IMAGE" bash -euo pipefail -c '
    step() { printf "\n==> %s\n" "$*"; }
    mkdir /w && tar -x -C /w && cd /w
    step "Node $(node -v) (Produktion: Node 22 im App-Image)"
    step "PostgreSQL 16 und gpg für die Datenbank- und Sicherungstests"
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq >/dev/null && apt-get install -y -qq --no-install-recommends postgresql-16 gnupg >/dev/null
    step "npm ci";            npm ci --no-audit --no-fund
    step "Lint";              npm run lint
    step "Typecheck";         npm run typecheck
    step "Unit-Tests";        npm run test:unit
    step "Build";             npm run build
    [ "$MODE" = --schnell ] && exit 0
    step "Datenbank & Mandantentrennung (RLS), Server";  npm run test:db
    [ "$MODE" = --voll ] || exit 0
    step "Browsertests";      npm run test:e2e
    step "Gesamttest (API + PostgreSQL + Browser)"
    npm run test:e2e:fullstack -- --project desktop-chromium --project mobile-android
  ' 2>&1 | tee "$LOG"
RC=${PIPESTATUS[1]}
set -e
if [ "$RC" = 0 ]; then
  echo "PRÜFUNG BESTANDEN: ${SHA:0:12} ($MODE)" | tee -a "$LOG"
else
  echo "PRÜFUNG FEHLGESCHLAGEN: ${SHA:0:12} ($MODE), Exit $RC – Details: $LOG" | tee -a "$LOG"
fi
exit "$RC"
}
main "$@"
