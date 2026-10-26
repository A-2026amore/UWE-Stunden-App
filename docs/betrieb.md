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

- Backups: täglicher verschlüsselter `pg_dump` plus WAL-Archivierung für Point-in-Time-Recovery
  in einen getrennten Speicher in der EU (z. B. Hetzner Storage Box). Wiederherstellung monatlich testen.
- Überwachung: Fehlerübersicht im Super-Admin (geplant), Server-Logs, Erreichbarkeitsprüfung.
- Updates der PWA: Der Service Worker der Mitarbeiter-App (`/app/sw.js`, Bereich nur `/app/`) lädt eine neue
  Version im Hintergrund; die App zeigt dann „Neue Version verfügbar – neu laden“. Er berührt weder die Alt-App
  noch fremde Caches (Details Abschnitt 7.4).

## 5. Wiederherstellung

| Fall | Vorgehen |
|---|---|
| Mitarbeiter-Handy verloren (Alt-App) | Backup-Datei des Mitarbeiters in der Alt-App wiederherstellen |
| Mitarbeiter-Handy verloren (Plattform) | Anmeldung auf neuem Gerät, Daten kommen vom Server; nicht synchronisierte Offline-Einträge des alten Geräts sind verloren |
| Versehentlich gelöschter Eintrag | Soft Delete: Chef/Betreiber stellt aus `time_entry_revisions` wieder her (mit Begründung, protokolliert) |
| Datenbankfehler | Wiederherstellung aus Tages-Backup bzw. Point-in-Time-Recovery (WAL-Archiv); danach Geräte synchronisieren lassen, Offline-Einträge werden idempotent nachgeladen |
| Fehlerhafte Plattform-Version | Vorherige Version des Builds erneut ausliefern; Datenbankmigrationen sind nur additiv |
| Fehlerhafte Alt-App-Version | Vorherigen Commit auf `main` wiederherstellen (nur mit Freigabe) |

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
- Ohne SMTP werden E-Mails nur in der Entwicklung ins Log geschrieben; in Produktion nie.
- Rate-Limits liegen im Prozessspeicher: **eine** API-Instanz betreiben (oder gemeinsamen Speicher ergänzen).
- Tests: `npx vitest run --project db --no-file-parallelism tests/server`.

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
  Den Link selbst sieht nur die eingeladene Person (sonst könnte jemand anderes das Konto für diese E-Mail-Adresse
  anlegen). Ohne SMTP in Produktion meldet das Portal, dass nichts zugestellt wurde.
- Service Worker nur für die Mitarbeiter-App: `app/sw.js`, Bereich `/app/`, nur in Produktions-Builds über HTTPS
  (oder `localhost`). Er speichert ausschließlich die App-Hülle (beim Build erzeugte Liste), nie `/api/…`.
  Cache-Namen beginnen mit `stundenwerk-app-`; gelöscht werden nur eigene ältere Versionen. Löscht eine andere App
  derselben Herkunft den Cache (die Alt-App löscht bei Updates alle fremden Caches), füllt der Service Worker ihn
  beim nächsten Start wieder auf.

### 7.5 Checkliste Inbetriebnahme API-Modus

1. Migrationen einspielen (ohne `db/seed.sql`), `app_api`-Passwort setzen (`server/README.md`).
2. `VITE_DATA_MODE=api npm run build`.
3. `api.env`: `NODE_ENV=production`, `DATABASE_URL`, `PUBLIC_ORIGIN=https://…`, `TRUST_PROXY=1`, `STATIC_DIR`, `SMTP_*`.
4. Dienst neu starten, `curl -fsS https://zeit.example.de/api/health` → `{"ok":true}`.
5. Ersten Super-Admin anlegen, Passwort mit `server/src/cli.ts set-password` setzen, im Admin-Portal anmelden.
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

