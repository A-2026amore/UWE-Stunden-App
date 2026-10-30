#!/usr/bin/env bash
# Richtet den E-Mail-Versand (SMTP) der Testumgebung stunden-test.appzentrale24.de ein.
# Fragt alle Angaben ab; das Passwort wird verdeckt eingegeben und nur in deploy/.env (Rechte 600) gespeichert.
# Ändert nur die SMTP_*-Zeilen in /srv/stunden-test/deploy/.env und startet danach den App-Container neu.
set -euo pipefail

DIR=/srv/stunden-test
ENV="$DIR/deploy/.env"
BACKUP=/root/stunden-test-env.vor-mail
C=(docker compose -f "$DIR/deploy/docker-compose.yml" --env-file "$ENV")

die() { echo "FEHLER: $*" >&2; exit 1; }

[ "$(id -u)" = 0 ] || die "Bitte als root ausführen."
[ -f "$ENV" ] || die "$ENV nicht gefunden."
grep -q '^STAGE=test$' "$ENV" || die "$ENV ist nicht die Testumgebung (STAGE=test fehlt) – nichts verändert."

echo "E-Mail-Versand für die Testumgebung einrichten."
echo "Die Angaben findest du beim Mail-Anbieter unter 'SMTP' bzw. 'Postausgangsserver'."
echo
read -r -p "Postausgangsserver (z. B. smtp.ionos.de): " host
read -r -p "Port [587]: " port; port=${port:-587}
if [ "$port" = 465 ]; then tlsmode=implicit; else tlsmode=starttls; fi
read -r -p "Benutzername (meist die volle Mailadresse): " user
read -r -p "Absenderadresse [$user]: " from; from=${from:-$user}
read -r -s -p "Passwort (wird nicht angezeigt): " pass; echo
read -r -s -p "Passwort wiederholen: " pass2; echo

[[ "$host" =~ ^[A-Za-z0-9.-]+$ ]] || die "Servername ungültig."
[[ "$port" =~ ^[0-9]+$ ]] || die "Port ungültig."
[[ "$from" =~ ^[^[:space:]@\<\>\']+@[^[:space:]@\<\>\']+$ ]] || die "Absenderadresse ungültig."
[[ "$user" != *"'"* ]] || die "Benutzername darf kein Hochkomma enthalten."
[ -n "$pass" ] || die "Passwort leer."
[ "$pass" = "$pass2" ] || die "Passwörter stimmen nicht überein."
[[ "$pass" != *"'"* ]] || die "Das Passwort enthält ein Hochkomma ('). Bitte beim Anbieter ein Passwort ohne Hochkomma setzen."

install -m 600 "$ENV" "$BACKUP"
echo "Sicherung der bisherigen Datei: $BACKUP"

tmp=$(mktemp "$DIR/deploy/.env.XXXXXX")
chmod 600 "$tmp"
grep -v -E '^SMTP_(HOST|PORT|TLS|USER|PASSWORD|FROM|INSECURE_TLS)=' "$ENV" > "$tmp" || true
# Einfache Hochkommas: Docker Compose übernimmt den Wert wörtlich (auch $, # und Leerzeichen).
{
  echo "SMTP_HOST='$host'"
  echo "SMTP_PORT='$port'"
  echo "SMTP_TLS='$tlsmode'"
  echo "SMTP_USER='$user'"
  echo "SMTP_PASSWORD='$pass'"
  echo "SMTP_FROM='$from'"
} >> "$tmp"
mv "$tmp" "$ENV"
unset pass pass2

"${C[@]}" config --quiet || { install -m 600 "$BACKUP" "$ENV"; die "Konfiguration ungültig – alte Datei wiederhergestellt."; }

echo "Starte die App neu …"
"${C[@]}" up -d stundenwerk-app
for _ in $(seq 1 30); do
  state=$(docker inspect -f '{{.State.Health.Status}}' stunden-test-app 2>/dev/null || echo unbekannt)
  [ "$state" = healthy ] && break
  sleep 2
done
if [ "$state" != healthy ]; then
  echo "Die App ist nicht gestartet (Status: $state). Letzte Meldungen:"
  docker logs --tail 20 stunden-test-app 2>&1 | grep -v -i password || true
  install -m 600 "$BACKUP" "$ENV"
  "${C[@]}" up -d stundenwerk-app
  die "Alte Einstellungen wiederhergestellt. Bitte diese Meldung (ohne Passwort) an Claude schicken."
fi

echo
echo "FERTIG: Die App läuft mit Mailversand ($host:$port, $tlsmode, Absender $from)."
echo "Jetzt testen: im Chef-Portal einen Test-Mitarbeiter mit deiner eigenen Mailadresse anlegen und 'Zugang senden'."
echo "Fehler beim Versand prüfen mit:  docker logs --since 10m stunden-test-app 2>&1 | grep -i mail"
