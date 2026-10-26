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
- Updates der PWA: neue Version wird beim nächsten Öffnen geladen; der Service Worker der
  Plattform ist auf ihren eigenen Pfad begrenzt und berührt die Alt-App nicht.

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
