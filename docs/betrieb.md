# Deployment, Betrieb und Wiederherstellung

## 1. Umgebungen

| Umgebung | Quelle | Adresse | Daten |
|---|---|---|---|
| Produktion (Alt-App) | Branch `main`, Repository-Stamm | https://a-2026amore.github.io/UWE-Stunden-App/ | echte Mitarbeiterdaten, nur auf den Geräten |
| Entwicklung | Branch `develop` | lokal: `npm run dev` | Demo-Daten |
| CI-Vorschau | GitHub Actions Artefakt `platform-dist` | Download aus dem Actions-Lauf | Demo-Daten |
| Staging (geplant) | `develop` | separater Hosting-Dienst, Entscheidung offen | nur anonyme Testdaten |
| Produktion Plattform (geplant) | `main` nach Freigabe | offen | echte Daten, nach Freigabe |

## 2. Lokale Entwicklung

```bash
npm ci
npm run dev            # Plattform mit Demo-Daten (http://localhost:5173)
npm run serve:legacy   # Alt-App lokal (http://127.0.0.1:4173)
npm test               # Unit- und Datenbanktests
npm run test:e2e       # Browsertests (Playwright)
```

Datenbanktests starten automatisch einen temporären lokalen PostgreSQL-16-Server oder nutzen
`DATABASE_URL`.

## 3. Deployment-Regeln

- Kein automatisches Deployment auf `main` oder GitHub Pages.
- Änderungen an `main` nur per Pull Request mit grüner CI **und** ausdrücklicher Freigabe des
  Auftraggebers.
- Geheimnisse (Datenbankpasswörter, Sitzungsschlüssel, SMTP-Zugang) niemals ins Repository; nur als
  GitHub Secrets bzw. Umgebungsdatei auf dem Server. Der Browser erhält keine Geheimnisse.

### Server einrichten (nach Freigabe und Servermiete durch den Auftraggeber)
1. Server in Deutschland mieten (Auftraggeber, inkl. AV-Vertrag), z. B. Ubuntu LTS.
2. Härtung: nur SSH-Schlüssel, Firewall (nur 443/22), automatische Sicherheitsupdates.
3. PostgreSQL 16 installieren, nur lokal erreichbar; Migrationen `db/migrations/*.sql` in Reihenfolge.
4. Nur in Test/Staging: `db/seed.sql` (Demo-Mandanten). Niemals in Produktion.
5. Node-API als Systemdienst hinter einem Reverse Proxy mit TLS (z. B. Caddy, automatisches Let's-Encrypt-Zertifikat).
6. Geheimnisse (Datenbank-Passwort, Sitzungsschlüssel, SMTP) nur in einer Umgebungsdatei auf dem Server mit Rechten 600.
7. Ersten Super-Admin über die Datenbankkonsole in `platform_admins` eintragen.

## 4. Betrieb

- Backups: täglich `deploy/backup.sh` (verschlüsselter `pg_dump`, Prüfsumme, Übergabe an das vorhandene
  restic-Backup zur Hetzner Storage Box) und monatlich eine Wiederherstellungsprobe mit
  `deploy/restore-test.sh` – Schritt für Schritt in Abschnitt 5.1. WAL-Archivierung (Point-in-Time-Recovery)
  ist **nicht** eingerichtet; Datenverlust im schlimmsten Fall: seit der letzten Sicherung.
- Überwachung: Fehlerübersicht im Super-Admin (geplant), Server-Logs, Erreichbarkeitsprüfung.
- Updates der PWA: Der Service Worker der Mitarbeiter-App (`/app/sw.js`, Bereich nur `/app/`) lädt eine neue
  Version im Hintergrund; die App zeigt dann „Neue Version verfügbar – neu laden“. Er berührt weder die Alt-App
  noch fremde Caches (Details Abschnitt 7.4).

## 5. Wiederherstellung

| Fall | Vorgehen |
|---|---|
| Mitarbeiter-Handy verloren (Alt-App) | Backup-Datei des Mitarbeiters in der Alt-App wiederherstellen |
| Mitarbeiter-Handy verloren (Plattform) | Anmeldung auf neuem Gerät, Daten kommen vom Server; nicht synchronisierte Offline-Einträge des alten Geräts sind verloren |
| Handy mit Authenticator-App verloren | Anmeldung mit einem Wiederherstellungscode, dann in den Einstellungen 2FA neu einrichten; ohne Codes: Zurücksetzen durch den Betrieb (Abschnitt 6.1) |
| Versehentlich gelöschter Eintrag | Soft Delete: Chef/Betreiber stellt aus `time_entry_revisions` wieder her (mit Begründung, protokolliert) |
| Datenbankfehler | Wiederherstellung aus dem Tages-Backup (Abschnitt 5.1); danach Geräte synchronisieren lassen, Offline-Einträge werden idempotent nachgeladen |
| Fehlerhafte Plattform-Version | Vorherige Version des Builds erneut ausliefern; Datenbankmigrationen sind nur additiv |
| Fehlerhafte Alt-App-Version | Vorherigen Commit auf `main` wiederherstellen (nur mit Freigabe) |

### 5.1 Datenbank-Backup und Wiederherstellung (Schritt für Schritt)

**Was gesichert wird.** `deploy/backup.sh` erzeugt je Lauf ein verschlüsseltes Archiv
`stunden-<STAGE>-<UTC-Zeit>.tar.gpg` und die Prüfsumme `….tar.gpg.sha256`. Im Archiv: `database.dump`
(`pg_dump` Custom-Format), `roles.sql` (Rollen **ohne** Passwörter), `manifest.txt` (Zeitpunkt, Versionen,
Zeilenzahlen aus demselben Schnappschuss wie der Dump) und `migrations.tsv` (Migrationsstand mit Prüfsummen).
Unverschlüsselt landet nichts dauerhaft auf der Platte (nur kurz im Arbeitsverzeichnis, Rechte 700, wird sofort
gelöscht). Nicht im Backup: `deploy/.env` und der `TOTP_ENCRYPTION_KEY` – getrennt aufbewahren (Passwort-Manager
des Inhabers); ohne TOTP-Schlüssel funktionieren eingerichtete Zwei-Faktor-Anmeldungen nach einer
Wiederherstellung nicht mehr (Abschnitt 6.1).

Das bestehende zentrale Backup (`pg_dumpall` über das Label `de.appzentrale24.backup`) bleibt unverändert; dieses
Skript ist eine zusätzliche, prüfbare Sicherung und ändert keine Server-Backup-Konfiguration.

**Einrichten (einmalig, nur nach Freigabe, auf dem Server):**

1. Schlüssel: empfohlen ist ein GPG-Schlüsselpaar, dessen **privater** Schlüssel nur offline beim Inhaber liegt
   (Server kann dann verschlüsseln, aber nicht entschlüsseln):
   `gpg --quick-gen-key "Schichtklar24 Backup <backup@…>" ed25519 default never` (auf einem sicheren Rechner),
   `gpg --export --armor <Fingerabdruck> > backup-public.asc`, auf dem Server `gpg --import backup-public.asc`.
   Alternative: Passphrase-Datei (`openssl rand -hex 32 > /root/.stunden-backup-pass; chmod 600 …`), Passphrase
   zusätzlich offline aufbewahren.
2. Probelauf: `BACKUP_GPG_RECIPIENT=<Fingerabdruck> deploy/backup.sh --compose deploy/.env`
   → Ausgabe „fertig: /var/backups/stunden-<STAGE>/stunden-….tar.gpg“.
3. Übergabe an restic (vorhandenes Repository auf der Storage Box, Zugangsdaten wie bisher in dessen
   Umgebungsdatei): `BACKUP_HOOK='restic backup --tag stunden --tag "$STAGE" "$@"'`. Das Skript ruft den Hook
   nur nach erfolgreicher Sicherung auf und meldet einen Fehler des Hooks mit Exit-Code ≠ 0.
4. Zeitplan (Beispiel systemd-Timer oder Cron, täglich 02:30):
   `30 2 * * * cd /srv/stunden-prod && BACKUP_GPG_RECIPIENT=… BACKUP_HOOK='…' BACKUP_STATUS_FILE=/var/lib/stunden/letzte-sicherung deploy/backup.sh --compose deploy/.env >> /var/log/stunden-backup.log 2>&1`
   `BACKUP_STATUS_FILE` speist „Letzte Sicherung“ in der Systemübersicht (Datei dafür read-only in den
   App-Container einbinden und dort `BACKUP_STATUS_FILE` setzen). Lokal bleiben die letzten 14 Sätze
   (`BACKUP_KEEP_LOCAL`).

**Wiederherstellungsprobe (monatlich und nach jeder Änderung am Backup):**

```bash
# 1. Archiv holen (lokal vorhanden oder aus restic):
restic restore latest --tag stunden --target /tmp/rp --include '/var/backups/stunden-prod'
# 2. Auf einem Rechner mit dem privaten Schlüssel (oder mit BACKUP_PASSPHRASE_FILE):
deploy/restore-test.sh --docker --migrations db/migrations /tmp/rp/var/backups/stunden-prod/stunden-prod-….tar.gpg
#    ohne Docker, mit installiertem PostgreSQL 16:  --local
```

Das Skript prüft Prüfsumme, Entschlüsselung, Dump-Prüfsumme, spielt Rollen und Dump in eine **Wegwerf-Datenbank**
ein (eigener Cluster bzw. Container ohne Netz – die laufende Umgebung bleibt unberührt) und prüft Zeilenzahlen
(Mandanten, Mitarbeitende, Arbeitszeiten, Protokoll) gegen das Manifest, den Migrationsstand, RLS auf allen
Tabellen, die Vollständigkeit der RLS-Richtlinien, dass die Anfragerolle ohne Anmeldung keine Arbeitszeiten
sieht, die Rollen ohne BYPASSRLS und den festen `search_path` der SECURITY-DEFINER-Funktionen. Ergebnis
„ERGEBNIS: Wiederherstellung erfolgreich geprüft.“ und Exit-Code 0; sonst Zeilen mit `FEHLER`. Datum und Ergebnis
im Betriebsprotokoll festhalten.

Automatisch geprüft: `tests/server/backup-restore.test.ts` (Passphrase und öffentlicher Schlüssel,
manipuliertes Archiv, falsche Passphrase, Verweigerung ohne Verschlüsselung, Hook und Statusdatei) und der
CI-Job „Container-Image (Bau + Start)“ (Backup aus dem Compose-Container, Probe mit `--docker`). Die Sicherung
im Compose-Modus und `--docker` sind **nur in der CI** gelaufen (in der Entwicklungsumgebung gibt es keinen
Docker-Daemon); die echte Hetzner-Sicherung wurde von hier aus **nicht** wiederhergestellt – das muss einmal auf
dem Server mit einem echten Archiv durchgespielt werden.

**Echte Wiederherstellung (Notfall, nur nach Freigabe).** Die Schritte 4–5 entsprechen dem, was die Probe automatisch tut; der Ablauf als Ganzes ist auf dem Server noch **nicht** erprobt.

1. Ruhe herstellen: `$C stop stundenwerk-app` (keine neuen Schreibzugriffe). Letztes **geprüftes** Archiv wählen.
2. Erst die Probe laufen lassen (oben) – nur ein Archiv mit „erfolgreich geprüft“ verwenden.
3. Neue, leere Datenbank-Umgebung: vorhandenes Volume **nicht löschen**, sondern z. B. mit anderem `STAGE`
   (`prod-restore`) neu aufsetzen: `$C up -d db`.
4. Archiv entschlüsseln: `gpg -d stunden-prod-….tar.gpg | tar -x -C /root/restore` (Rechte 700).
5. Rollen und Daten einspielen:
   `$C exec -T db psql -U "$POSTGRES_USER" -d postgres -v ON_ERROR_STOP=0 < /root/restore/roles.sql`
   (Meldungen „already exists“ sind normal; heißt der Superuser der neuen Umgebung anders als `POSTGRES_USER` der
   gesicherten, vorher `sed -E 's/^(GRANT .*) GRANTED BY [^;]+;$/\1;/' -i /root/restore/roles.sql` – so macht es auch
   die Probe), dann
   `$C exec -T db pg_restore -U "$POSTGRES_USER" -d stunden --clean --if-exists --exit-on-error < /root/restore/database.dump`.
6. `$C run --rm migrate` – setzt das Passwort von `app_api` aus `deploy/.env` (Rollen sind ohne Passwörter
   gesichert) und spielt neuere Migrationen ein.
7. `$C up -d stundenwerk-app`, Anmeldung und eine Stichprobe prüfen, dann den Reverse Proxy auf die wiederhergestellte
   Umgebung zeigen lassen. Entpackte Dateien löschen (`rm -rf /root/restore`).

## 6. Node-API betreiben

Die API (`server/`) läuft ohne Build-Schritt direkt mit Node 22 (TypeScript-Typentfernung):

```bash
node --experimental-strip-types --disable-warning=ExperimentalWarning \
     --import ./server/register.mjs server/src/main.ts
```

- Konfiguration nur über Umgebungsvariablen (`DATABASE_URL` als Rolle `app_api`, `PUBLIC_ORIGIN`,
  optional `SMTP_*`); vollständige Liste, systemd-Unit, Caddy-Beispiel und Backup-Hinweise in
  `server/README.md`.
- Passwörter setzt der Betrieb mit `server/src/cli.ts set-password <email>` (Passwort über stdin).
- Einladungslinks ohne E-Mail (kein SMTP): `server/src/cli.ts invite-link <mandant-kurzname> <email> <rolle>`.
  Der Link erscheint nur auf der Konsole, nie im Log oder in der API (Details `server/README.md`).
- Ohne SMTP werden E-Mails nur in der Entwicklung ins Log geschrieben; in Produktion nie.
- Rate-Limits liegen im Prozessspeicher: **eine** API-Instanz betreiben (oder gemeinsamen Speicher ergänzen).
- Tests: `npx vitest run --project db --no-file-parallelism tests/server`.

### 6.1 Zwei-Faktor-Anmeldung: Schlüssel, Rotation, Notfall

| Variable | Pflicht | Standard | Bedeutung |
|---|---|---|---|
| `TOTP_ENCRYPTION_KEY` | in Produktion | Entwicklungsschlüssel (nur ohne `NODE_ENV=production`) | 32 Byte, Base64 oder 64 Hex-Zeichen. Verschlüsselt die TOTP-Geheimnisse (AES-256-GCM). Ohne Schlüssel startet die API in Produktion nicht. |
| `TOTP_ENCRYPTION_KEY_PREVIOUS` | – | leer | Frühere Schlüssel, kommagetrennt – nur zum Entschlüsseln während einer Rotation. |
| `TOTP_ISSUER` | – | `Schichtklar24` | Name in der Authenticator-App (1–40 Zeichen, kein Doppelpunkt). |
| `PAYMENT_PROVIDER` | – | `none` | Nur `none` erlaubt (Preismodell: manuelle Abrechnung, `docs/preismodell.md`). |
| `APP_COMMIT` | – | leer | Git-Commit des laufenden Builds (7–40 Hex-Zeichen), nur zur Anzeige im Super-Admin unter „Systemstatus“. |
| `BACKUP_STATUS_FILE` | – | leer | Datei, in die der nächtliche Sicherungsjob nach **erfolgreicher** Sicherung einen ISO-Zeitstempel schreibt (oder die er nur `touch`t). „Systemstatus“ zeigt daraus „Letzte Sicherung“; ohne Variable: „nicht bekannt“. Ersetzt keinen Wiederherstellungstest. |
| `RATE_LIMIT_2FA_PER_ACCOUNT` / `RATE_LIMIT_2FA_PER_IP` | – | `5` / `50` | Falsche Codes je Konto bzw. IP im Zeitfenster `RATE_LIMIT_WINDOW_MINUTES`. |
| `RATE_LIMIT_LOGIN_PER_EMAIL` / `RATE_LIMIT_RESET_PER_EMAIL` | – | `30` / `10` | Fehlanmeldungen bzw. Reset-Mails je E-Mail-Adresse über **alle** IPs. Wer ein Konto absichtlich mit Fehlversuchen sperrt, blockiert es höchstens bis zum Ende des Zeitfensters (bewusster Kompromiss; Werte bei Bedarf anpassen). |

**Schlüssel erzeugen** (einmalig, nur in `/etc/uwe-zeit/api.env`, Rechte 600, nie ins Repository):

```bash
openssl rand -base64 32
```

**Sichern:** Der Schlüssel gehört **nicht** in dasselbe Backup wie die Datenbank (sonst schützt die
Verschlüsselung nicht), aber er muss gesichert sein – z. B. im Passwort-Manager des Auftraggebers.
Geht er verloren, können sich alle Konten mit 2FA nur noch mit Wiederherstellungscodes anmelden und
müssen die Zwei-Faktor-Anmeldung danach neu einrichten.

**Rotation** (z. B. jährlich oder bei Verdacht auf Offenlegung):
1. Neuen Schlüssel erzeugen. In `api.env`: `TOTP_ENCRYPTION_KEY=<neu>`,
   `TOTP_ENCRYPTION_KEY_PREVIOUS=<alt>`. Dienst neu starten.
2. Neue Einrichtungen nutzen sofort den neuen Schlüssel; bestehende Geheimnisse werden bei der nächsten
   erfolgreichen Code-Eingabe automatisch neu verschlüsselt.
3. Fortschritt prüfen (Schlüssel-ID = zweiter Teil des Chiffrats):
   `select split_part(secret_ciphertext, '.', 2) as key_id, count(*) from auth.totp_factors group by 1;`
4. Wenn keine Zeile mehr die alte ID trägt (oder nach einer festgelegten Frist), `TOTP_ENCRYPTION_KEY_PREVIOUS`
   entfernen und neu starten. Konten, deren Geheimnis dann noch mit dem alten Schlüssel verschlüsselt ist,
   können sich nur mit einem Wiederherstellungscode anmelden bzw. müssen vom Betrieb zurückgesetzt werden (unten).
   Bei Offenlegung des alten Schlüssels: Betroffene Konten zurücksetzen und neu einrichten lassen.

**Smartphone und Wiederherstellungscodes verloren** (Identität vorher außerhalb der App prüfen, z. B. persönlich
oder Rückruf über die bekannte Nummer; eine Oberfläche dafür gibt es noch nicht). Wartung als Datenbank-Administrator:

```sql
-- löscht Geheimnis und Wiederherstellungscodes (Kaskade); Audit-Eintrag two_factor.disabled entsteht automatisch
delete from auth.totp_factors where user_id = (select id from auth.users where email = 'person@firma.example');
-- vorsichtshalber alle Sitzungen beenden
update auth.sessions set revoked_at = now()
 where user_id = (select id from auth.users where email = 'person@firma.example') and revoked_at is null;
```

Danach meldet sich die Person nur mit Passwort an; ist 2FA für sie Pflicht, sieht sie direkt die Neueinrichtung.

### 6.1a Mandanten stilllegen bzw. löschen (QA 2026-10-28, B7)

- Die API hat **bewusst keinen** Lösch- oder Archivierungsendpunkt für Mandanten. Stilllegen = Status
  `suspended` (Super-Admin im Admin-Portal bzw. `POST /api/platform/tenants/:id/status` mit Grund). Gesperrte
  Mandanten sind für ihre Mitglieder vollständig gesperrt und öffentlich nicht mehr auffindbar (404).
- Physisches Löschen ist eine **Wartungsarbeit** des Betreibers direkt in der Datenbank (Eigentümerrolle, nicht
  `app_api`), nur nach Backup und nur für Test-/Demo-Mandanten (`is_demo = true`). Echte Mandanten unterliegen
  Aufbewahrungsfristen (`docs/security.md`, Abschnitt 7) – vor einer Löschung Freigabe des
  Auftraggebers einholen.
- Das Audit-Log ist append-only und hat keinen Fremdschlüssel auf `tenants`: Einträge eines gelöschten Mandanten
  bleiben erhalten (gewollt, Nachweis).
- Ablauf (nicht automatisiert getestet – zuerst in einer Kopie der Datenbank ausprobieren):

```sql
begin;
-- nur Demo-Mandanten; Kurzname genau prüfen
select id, name, is_demo, status from public.tenants where slug = 'qa-testfirma-a';
delete from public.tenants where slug = 'qa-testfirma-a' and is_demo;   -- Fremdschlüssel löschen abhängige Zeilen mit
-- Anzahl prüfen (erwartet: 1), sonst rollback;
commit;
```

Ein eigenes Aufräum-Skript für `is_demo`-Mandanten der Testumgebung ist ein offener Punkt. Für **echte**
Mandanten gilt ausschließlich das Verfahren in 6.1b.

### 6.1b Vertragsende: Datenexport und Löschung eines Mandanten (Migration 0020)

Grundlage: AGB/AV-Vertrag (Entwürfe, `recht/`). **Fristen sind rechtlich zu prüfen** (Rückgabe-/Exportfrist nach
Vertragsende, Löschfrist, Aufbewahrungsfristen des Kunden und der Plattform) – der Code legt keine Frist fest.

Beide Befehle laufen **nur auf der Server-Konsole** mit der Eigentümerrolle der Datenbank
(`MIGRATION_DATABASE_URL`, wie der Migrationsjob). Es gibt dafür keinen HTTP-Endpunkt; `app_api` und die
Anfragerollen dürfen die Funktionen nicht ausführen (Test). Jeder Lauf wird im Audit-Log protokolliert.

**1. Export (für jeden Status, auch `suspended`/`deactivated`, deren Inhaber sich nicht mehr anmelden kann):**

```bash
node --experimental-strip-types --disable-warning=ExperimentalWarning --import ./server/register.mjs \
  server/src/cli.ts export-tenant <mandant-kurzname> --out /root/vertragsende/<mandant-kurzname>-$(date +%F)
```

- Schreibt ein neues Verzeichnis (Rechte 0700, Dateien 0600; ein vorhandenes, nicht leeres Ziel wird abgelehnt):
  `firmendaten.json` (vollständiger Gesamtexport, gleiches Format wie „Gesamtexport der Firma“ im Chef-Portal:
  Stammdaten, Lizenzen, Abrechnungsmonate, Support-Freigaben, alle Personen mit Zeiten, Revisionen,
  Korrekturanfragen, Nachweisen, Kontobewegungen, Einladungen und das Audit-Log), `arbeitszeiten.csv`
  (Excel, Semikolon) und `SHA256SUMS` (`sha256sum -c SHA256SUMS`).
- Audit-Eintrag `tenant.operator_export` beim Mandanten. Schlägt das Schreiben fehl, wird auch der Audit-Eintrag
  zurückgerollt.
- Der Export enthält personenbezogene Daten: nur verschlüsselt an den Kunden übergeben (z. B. 7-Zip/AES mit
  getrennt übermitteltem Passwort), Übergabe dokumentieren, danach vom Server löschen.
- Der Inhaber eines **aktiven** Mandanten kann denselben Export weiterhin selbst im Chef-Portal abrufen. Ein
  Selbstbedienungs-Export für Inhaber gesperrter/deaktivierter Mandanten ist **nicht** umgesetzt (siehe unten).

**2. Löschung (nur Status `deactivated`, nach dem Export):**

```bash
# vorher: Mandant im Admin-Portal deaktivieren (mit Grund), Backup prüfen (5.1)
node --experimental-strip-types --disable-warning=ExperimentalWarning --import ./server/register.mjs \
  server/src/cli.ts delete-tenant <mandant-kurzname> --confirm <mandant-kurzname> \
  --after-export /root/vertragsende/<mandant-kurzname>-<datum>
# nur mit ausdrücklicher Freigabe ohne Export:  ... --confirm <mandant-kurzname> --without-export
```

- Prüft vorher: Kurzname zweimal identisch, Status `deactivated`, Export gehört zu diesem Mandanten (Kurzname und
  Kennung) und ist unverändert (Prüfsumme), und in der Datenbank ist ein Export protokolliert
  (`tenant.operator_export` oder `tenant.data_export`). Ohne Export nur mit `--without-export`.
- Läuft in **einer Transaktion**: jeder Fehler bricht alles ab, es bleibt nichts halb gelöscht; der Befehl kann
  danach erneut gestartet werden. Ein zweiter Lauf nach erfolgreicher Löschung findet den Mandanten nicht mehr
  (Exit-Code 1, nichts geändert).
- **Gelöscht** werden: alle Mitarbeitenden-Datensätze mit Zeiten, Revisionen, Korrekturanfragen, Monatsnachweisen
  und deren Verlauf, Arbeitszeitkonto-Buchungen, Statushistorie, Einladungen samt Einladungslinks, Abrechnungszeilen
  je Person; Anmeldekonten, die **nur** zu diesem Mandanten gehören (mit Sitzungen, Einmal-Links, 2FA) – Konten,
  die auch in einem anderen Mandanten oder als Plattform-Konto genutzt werden, bleiben; Lizenzen,
  Support-Freigaben, Mandanten-Statushistorie, offene Abrechnungsmonate, Logos/Branding und Kontaktdaten; das
  gesamte Audit-Log des Mandanten sowie mandantenlose Audit-Einträge über die gelöschten Konten. Zusätzlich
  leert ein Katalog-Durchlauf **jede weitere Tabelle mit Spalte `tenant_id`** (auch später hinzugefügte).
  Zum Schluss prüft die Funktion selbst über den Katalog, dass keine Zeile des Mandanten übrig ist – sonst Abbruch.
- **Aufbewahrt** (Buchhaltungsunterlagen der Plattform, keine Mitarbeiternamen): Rechnungen und Stornos
  (`invoices`, unveränderlich) und abgerechnete Monate (`billing_periods` mit Status ≠ `open`, nur Zahlen).
  Solange solche Zeilen existieren, bleibt die Mandantenzeile als anonymisierter Platzhalter
  („Gelöschter Mandant …“, Kurzname `geloescht-…`, ohne Kontakt, Standard-Branding, `deleted_at` gesetzt; nicht
  mehr änderbar, nicht reaktivierbar, keine neuen Mitglieder). Sonst wird auch die Mandantenzeile gelöscht.
  Hinweis: Rechnungen enthalten die Rechnungsanschrift des Kunden (Pflichtangabe) – Aufbewahrungsdauer rechtlich
  prüfen; danach ist ihre Löschung eine eigene, noch nicht umgesetzte Wartungsarbeit.
- **Audit-Entscheidung:** Die Audit-Zeilen des Mandanten enthalten Namen, E-Mail-Adressen und Bemerkungen
  (Vorher/Nachher-Daten) und werden **gelöscht**, nicht nur anonymisiert – sie sind im Export enthalten.
  Stattdessen bleibt **ein** anonymisierter Eintrag `tenant.deleted` (ohne Mandanten-Kennung in `tenant_id`, ohne
  Namen und Kurzname; `entity_id` = Mandanten-ID, Anzahl gelöschter Zeilen je Tabelle, aufbewahrte Zeilen,
  Zeitpunkt des letzten Exports, SHA-256 der Exportdatei bzw. `withoutExport`). Das Audit-Log bleibt für alle
  anderen Fälle append-only; die Ausnahme greift nur innerhalb dieser Funktion (Markierung der Transaktion in
  `private.tenant_deletions`, für Anfragerollen nicht beschreibbar).
- **Backups:** Ältere verschlüsselte Sicherungen enthalten die Daten bis zum Ablauf ihrer Aufbewahrung
  (restic-Rotation). Wiederherstellung einer Sicherung nach einer Löschung: Löschung danach erneut ausführen.
  Frist rechtlich prüfen und im AV-Vertrag nennen.

**Selbstbedienungs-Export für gesperrte Inhaber (Variante b) – bewusst nicht umgesetzt:** Gesperrte Zugänge
erhalten heute ohne 2FA dieselbe Antwort wie bei falschem Passwort (QA 2026-10-28, B4: keine Auskunft über
gesperrte Konten, gleiche Zeit, gleiche Ratenbegrenzung). Ein „nur Export“-Zugang würde diese Entscheidung
aufweichen und Anmeldung, Zwei-Faktor-Ablauf, Sitzungsprüfung (`asUser`), Demo-Repository und Oberflächen
gleichzeitig ändern – das ist in sicherheitskritischen Pfaden nicht ohne eigene Prüfung sauber machbar.
Stattdessen: Export durch den Betreiber (oben) und gesicherte Übergabe an den Inhaber; alternativ den Mandanten
für die Exportfrist reaktivieren (der Inhaber exportiert dann selbst im Chef-Portal). Falls gewünscht, als eigene
Aufgabe mit Sicherheitsprüfung planen.

## 6.2 Container-Betrieb (Docker Compose)

Für den Server mit zentralem Caddy (Netz `proxy`) gibt es ein mehrstufiges `Dockerfile` und
`deploy/docker-compose.yml` (App `stunden-${STAGE}-app` auf Port 3000 ohne veröffentlichte Ports, PostgreSQL 16 im
internen Netz, Migrationsjob `migrate`). Anleitung, Variablen und Backup: [`deploy/README.md`](../deploy/README.md).
Testumgebung: `stunden-test.appzentrale24.de`; Produktion (`stunden.appzentrale24.de`) erst nach Freigabe.

## 7. Plattform mit echtem Server (API-Modus)

Die drei Oberflächen (Mitarbeiter-App, Chef-Portal, Super-Admin) gibt es in zwei Varianten aus demselben Code:

| Variante | Bauen | Daten | Verwendung |
|---|---|---|---|
| Demo (Standard) | `npm run build` | Demo-Datenbank im Browser, Demo-Zugänge, Hinweise „Demo-Umgebung“ | Staging/Vorschau, CI-Artefakt |
| API | `VITE_DATA_MODE=api npm run build` | eigene Node-API + PostgreSQL, echte Anmeldung | Produktion (nach Freigabe) |

### 7.1 Build-Variablen (nur beim Bauen, landen im ausgelieferten JavaScript – keine Geheimnisse!)

| Variable | Standard | Bedeutung |
|---|---|---|
| `VITE_DATA_MODE` | `demo` | `api` = echte API. Alles andere = Demo. |
| `VITE_API_BASE` | leer (gleiche Herkunft) | Adresse der API, z. B. `https://zeit.example.de`. Empfehlung: leer lassen und Frontend + API unter **einer** Herkunft betreiben – das Sitzungs-Cookie ist `SameSite=Strict`, bei anderer Domain wird es nicht mitgesendet. |

Ergebnis liegt in `platform/dist/` (Seiten `index.html`, `app/`, `chef/`, `admin/`, `passwort-neu/`, `einladung/`,
`assets/` mit Hash im Dateinamen, `app/sw.js`).

Im API-Modus gibt es keine Demo-Zugänge, keine Hinweise „Demo-Umgebung“ und keinen Schalter „Offline simulieren“.
Läuft eine Sitzung ab (401), kehrt die Oberfläche zur Anmeldung zurück („Deine Sitzung ist abgelaufen …“); noch
nicht übertragene Einträge der Mitarbeiter-App bleiben auf dem Gerät und werden nach der Anmeldung gesendet. Ist der
Mandant gesperrt, erscheint „Der Firmenzugang ist derzeit gesperrt. Bitte wende dich an deinen Arbeitgeber.“

**Eine Sitzung für alle Bereiche:** Das Cookie gilt für die ganze Herkunft. Wer sich im Chef-Portal abmeldet, ist auch
in der Mitarbeiter-App desselben Browsers abgemeldet. Meldet sich in einem anderen Tab ein **anderes** Konto an,
überträgt die Mitarbeiter-App wartende Änderungen nicht unter diesem Konto, sondern meldet
„Auf diesem Gerät ist inzwischen ein anderes Konto angemeldet …“.

### 7.2 Ausliefern – empfohlen: die API liefert auch die Seiten aus (`STATIC_DIR`)

Ein Prozess, eine Herkunft, eine Sicherheitskonfiguration. Caddy macht nur TLS und leitet alles weiter.

```bash
cd /srv/uwe-zeit && sudo -u uwe-api env VITE_DATA_MODE=api npm run build
```

In `/etc/uwe-zeit/api.env` ergänzen:

```ini
STATIC_DIR=/srv/uwe-zeit/platform/dist
```

```caddy
zeit.example.de {
	encode zstd gzip
	reverse_proxy 127.0.0.1:3000
}
```

Verhalten mit `STATIC_DIR`:
- `/api/…` → API wie bisher (eigene strenge Header). Alles andere → Dateien aus `STATIC_DIR`, nur `GET`/`HEAD`.
- Keine versteckten Dateien (`.env` …), kein `..`, keine Symlinks aus dem Verzeichnis heraus.
- `/einladung` → Weiterleitung auf `/einladung/` (der Browser behält `#token=…`).
- Dateien unter `/assets/` mit Hash: ein Jahr Cache (`immutable`); HTML, `sw.js`, Manifest: `no-cache`.
- Content-Security-Policy der Seiten: `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data: blob:;
  connect-src 'self'; worker-src 'self'; manifest-src 'self'; object-src 'none'; base-uri 'self'; form-action 'self';
  frame-ancestors 'none'`. Der Vite-Build enthält keine Inline-Skripte und keine `<style>`-Blöcke oder
  `style`-Attribute im HTML (Stilangaben der Oberfläche setzt Preact per CSSOM, das ist von `style-src` nicht
  betroffen). Geprüft im Full-Stack-Test: jeder CSP-Verstoß im Browser lässt den Test fehlschlagen.

Startet die API ohne gültiges `STATIC_DIR` (Verzeichnis fehlt), bricht sie beim Start ab.

### 7.3 Alternative: Caddy liefert `platform/dist` aus

Möglich (siehe `server/README.md`, Caddy-Beispiel ohne `STATIC_DIR`). Dann müssen die Header oben (CSP, `nosniff`,
`Referrer-Policy`, `X-Frame-Options`) und die Cache-Regeln in Caddy gepflegt werden, und `try_files` muss
`{path}/index.html` enthalten, damit `/passwort-neu` und `/einladung` funktionieren.

### 7.4 Links aus E-Mails und Service Worker

- Passwort-Reset: `PUBLIC_ORIGIN + RESET_LINK_PATH#token=…` (Standard `/passwort-neu`), Einladung:
  `PUBLIC_ORIGIN + INVITE_LINK_PATH#token=…` (Standard `/einladung`). Die Standardwerte passen zu den gebauten Seiten
  `passwort-neu/` und `einladung/`. Nur ändern, wenn die Plattform unter einem Unterpfad läuft (dann beide Pfade inkl.
  Unterpfad setzen). Die Seiten entfernen das Token nach dem Lesen aus der Adresszeile.
- Das Chef-Portal zeigt nach „Mitarbeiter einladen“, wohin die Einladung ging („per E-Mail an … gesendet“, gültig bis …).
  Bei „Per E-Mail senden“ sieht den Link nur die eingeladene Person. Alternativ „Link selbst teilen (WhatsApp oder
  kopieren)“ bzw. später „Zugang senden“ → „Link erstellen“: Der Einmal-Link (7 Tage, nur einmal verwendbar, ein neuer
  Link macht alte ungültig) wird der Leitung angezeigt und kann per WhatsApp (wa.me mit vorausgefülltem Text) geteilt
  oder kopiert werden – so funktioniert die Einladung auch ganz ohne SMTP. Es wird nie ein Passwort versendet. Gehört
  die Adresse schon zu einem Konto, schickt der Server den Link nur per E-Mail (siehe `docs/security.md`). Ohne SMTP in
  Produktion meldet das Portal bei E-Mail-Einladungen, dass nichts zugestellt wurde.
- Service Worker nur für die Mitarbeiter-App: `app/sw.js`, Bereich `/app/`, nur in Produktions-Builds über HTTPS
  (oder `localhost`). Er speichert ausschließlich die App-Hülle (beim Build erzeugte Liste), nie `/api/…`.
  Cache-Namen beginnen mit `stundenwerk-app-`; gelöscht werden nur eigene ältere Versionen. Löscht eine andere App
  derselben Herkunft den Cache (die Alt-App löscht bei Updates alle fremden Caches), füllt der Service Worker ihn
  beim nächsten Start wieder auf.

### 7.5 Checkliste Inbetriebnahme API-Modus

1. Migrationen einspielen (ohne `db/seed.sql`), `app_api`-Passwort setzen (`server/README.md`).
2. `VITE_DATA_MODE=api npm run build`.
3. `api.env`: `NODE_ENV=production`, `DATABASE_URL`, `PUBLIC_ORIGIN=https://…`, `TRUST_PROXY=1`, `STATIC_DIR`, `SMTP_*`,
   `TOTP_ENCRYPTION_KEY` (Abschnitt 6.1, getrennt sichern).
4. Dienst neu starten, `curl -fsS https://zeit.example.de/api/health` → `{"ok":true}`.
5. Ersten Super-Admin anlegen, Passwort mit `server/src/cli.ts set-password` setzen, im Admin-Portal anmelden und
   die (für Plattformkonten vorgeschriebene) Zwei-Faktor-Anmeldung einrichten; Wiederherstellungscodes sicher ablegen.
6. Testmandant anlegen, Einladung an eine eigene Test-Adresse schicken, Link öffnen, Passwort setzen, anmelden.

Entwicklung mit Hot Reload gegen eine lokale API (Standard-`PUBLIC_ORIGIN` der API ist `http://localhost:5173`):

```bash
VITE_DATA_MODE=api VITE_DEV_API_PROXY=http://127.0.0.1:3000 npm run dev   # → http://localhost:5173/app/
```

Lokal den gebauten Stand ausprobieren (ohne SMTP stehen Reset-/Einladungslinks im Log):

```bash
VITE_DATA_MODE=api npm run build
DATABASE_URL=postgres://app_api:…@127.0.0.1:5432/uwe_zeit PUBLIC_ORIGIN=http://localhost:3000 \
  STATIC_DIR=platform/dist PORT=3000 npm run start:server
# → http://localhost:3000/app/
```

