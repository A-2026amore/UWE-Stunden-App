# DNS-Plan appzentrale24.de

Stand: Entwurf, **noch nichts geändert**. Jede DNS-Änderung erfolgt erst nach Ihrer Freigabe.

## 1. Erst prüfen (nur lesend)

`00-pruefen-windows.ps1` auf dem Windows-PC ausführen. Das Skript schreibt alle heutigen Einträge
in `dns-bericht.txt`, auch die E-Mail-Einträge (MX, SPF, DKIM, DMARC, autodiscover). Den Inhalt bitte in den Chat kopieren.
Er enthält keine Geheimnisse.

Alternativ im netcup Customer Control Panel (CCP) unter **Domains → appzentrale24.de → DNS** einen
Screenshot der Tabelle machen.

## 2. Geplante Subdomains

| Name | Zweck | Zugang am Anfang |
|---|---|---|
| `begivo.appzentrale24.de` | BEGIVO (Pilot Aachen) | Passwortschutz, bis Sie die Freischaltung erlauben |
| `stunden.appzentrale24.de` | Zeiterfassungsplattform (Mitarbeiter-App, Chef-Modul, Verwaltung) | Passwortschutz bis zur Abnahme |
| `telefon.appzentrale24.de` | KI-Telefonie: Dashboard und API (auch Twilio-Webhooks) | Passwortschutz bis zur Abnahme |
| `status.appzentrale24.de` | Monitoring (nur Administration) | dauerhaft Passwortschutz |
| `appzentrale24.de`, `www` | neutrale Startseite | öffentlich, Inhalt „im Aufbau“ |

Später (Mandanten der Stunden-App): eigene Subdomains je Kunde sind möglich (`firma.stunden.appzentrale24.de`). Das ist nicht nötig, weil die Marke über das Login zugeordnet wird.

## 3. Einzutragende Einträge (Schritt 1 – ohne Risiko für E-Mail)

Im netcup CCP **neue** Einträge hinzufügen. Bestehende Zeilen dabei **nicht** löschen oder ändern:

| Host | Typ | Ziel |
|---|---|---|
| `begivo` | A | `159.195.199.222` |
| `stunden` | A | `159.195.199.222` |
| `telefon` | A | `159.195.199.222` |
| `status` | A | `159.195.199.222` |
| `@` | CAA | `0 issue "letsencrypt.org"` *(nur wenn noch kein CAA-Eintrag existiert)* |

IPv6 (AAAA) erst eintragen, wenn die IPv6-Adresse des Servers bekannt ist (`01-bestandsaufnahme.sh`) und
die Firewall dafür geprüft ist.

Diese neuen Subdomains berühren MX, SPF, DKIM und DMARC nicht. Die E-Mail läuft unverändert weiter.

## 4. Hauptdomain (Schritt 2 – erst nach Prüfung des Berichts)

`@` und `www` auf den Server umzustellen ist nur dann unbedenklich, wenn **keiner** der folgenden Fälle vorliegt:

- Der MX-Eintrag zeigt auf `appzentrale24.de` selbst oder auf einen Namen, der per CNAME auf `@` verweist.
- `mail`, `imap`, `smtp` oder `webmail` sind CNAME auf `@`.
- Der SPF-Eintrag nutzt `a` oder `mx` und Mails werden vom Webhosting-Server versendet.

Bei netcup-E-Mail im Webhosting (MX `mx*.netcup.net` o. ä.) gilt: Den A-Eintrag von `@` ändern und **alle**
MX-, TXT- und `mail`-Einträge exakt so lassen. Das prüfe ich anhand Ihres Berichts, bevor ich die Umstellung empfehle.

## 5. HTTPS

Caddy holt die Let's-Encrypt-Zertifikate automatisch, sobald ein Name auf den Server zeigt und Port 80/443 offen ist.
Die Erneuerung läuft ebenfalls automatisch. Prüfen: `docker compose -f /srv/appzentrale24/proxy/docker-compose.yml logs caddy | grep -i certificate`.
