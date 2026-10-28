# Changelog

Format nach [Keep a Changelog](https://keepachangelog.com/de/1.1.0/), Versionen nach SemVer.

## [Unveröffentlicht] – Plattform 0.1.0 (Branch `develop`)

### Hinzugefügt
- Betreiberbefehl `cli.ts invite-link <mandant> <email> <rolle>` (QA 2026-10-28, B1): Einladungslink ohne
  E-Mail, Ausgabe nur auf der Konsole; Migration `0010_operator_invitation.sql`.
- Container-Betrieb: mehrstufiges `Dockerfile` (Node 22, Lockfile, Nicht-root, API liefert die gebauten
  Oberflächen aus), `deploy/docker-compose.yml` mit PostgreSQL 16 im internen Netz, externem Netz `proxy`,
  Backup-Label und Healthchecks, `deploy/.env.example`, `deploy/README.md`. Migrationsjob
  `server/src/migrate.ts` (Versionstabelle `ops.schema_migrations`, Prüfsummen, Passwort für `app_api`).
  `pg` ist jetzt Laufzeitabhängigkeit. CI baut und startet das Image (kein Push).
- API: `TRUST_PROXY_CIDRS` – `X-Forwarded-For` nur von Absendern aus den angegebenen Netzen.
- Entwicklungswerkzeuge: Vite, TypeScript, Preact, Vitest, Playwright, ESLint.
- GitHub Actions: Lint, Typecheck, Unit-, Datenbank- und Browsertests, Build-Artefakt,
  Geheimnis-Scan, CodeQL, Dependabot; Pull-Request- und Issue-Vorlagen.
- Geheimnis-Scan: `.gitleaks.toml` nimmt Testdateien (nur Testpasswörter/-schlüssel) und
  Speicherschlüssel-Namen der Alt-App (`uwe_…`) als Fehlalarme aus.
- API: CORS-Antwort übernimmt nur noch den konfigurierten Origin-Wert, `null` wird nie akzeptiert (CodeQL).
- Ist-Analyse, Architektur (eigener Server in Deutschland), Migrationsplan, Betriebshandbuch.
- Fachlogik (`platform/src/core`): Pausenregeln, Arbeitszeitkonto (Schuljahr/Kalenderjahr,
  konfigurierbar), Migration, mehrseitiges PDF; Vergleichstests gegen die Alt-App.
- PostgreSQL-Schema (`db/`) mit Row Level Security, Revisionen, Soft Delete, Audit-Log,
  Support-Freigaben, Lizenzen inkl. kostenlosem Pilot; Härtung (Migration 0008).
- Eigene Node-API (`server/`): Anmeldung mit Sitzungs-Cookie, Passwort vergessen, Einladungen,
  Rate-Limits, CSRF-Schutz, serverseitige Pausenprüfung.
- Designsystem mit White-Label und Demo von Mitarbeiter-App, Chef-Portal und Super-Admin.
- Offline-Erfassung mit Synchronisierung und Konfliktbehandlung; Übernahme der Altdaten
  (Backup-Datei oder Browser-Speicher) mit Bericht vor dem Schreiben.
- Produktionsmodus (`npm run build:api`): Apps arbeiten gegen die eigene API; Seiten „Passwort neu setzen“
  und „Einladung annehmen“; Service Worker nur für die Mitarbeiter-App (Offline-Start); Gesamttests mit
  echter Datenbank.
- Zwei-Faktor-Anmeldung (TOTP nach RFC 6238, Authenticator-App): freiwillig für alle Konten, Pflicht für
  Plattformkonten (`super_admin`, `support`) und – wenn der Inhaber es einschaltet – für Inhaber und Vorgesetzte
  eines Mandanten. Anmeldung in zwei Schritten, Einrichtung mit QR-Code (eigener Encoder) in den Einstellungen
  aller drei Bereiche, 10 Wiederherstellungscodes (Anzeige und Textdatei), Deaktivieren nur mit Passwort und Code.
  Geheimnis AES-256-GCM-verschlüsselt (`TOTP_ENCRYPTION_KEY`, Rotation über `TOTP_ENCRYPTION_KEY_PREVIOUS`),
  Replay-Schutz, Rate-Limits, Audit-Einträge. Migration `0009_two_factor.sql` (nur additiv).
  Demo: Geheimnis im Browser, Schaltfläche „Demo: aktuellen Code einsetzen“.
- Tests: 284 Unit-, 209 Datenbank-/API-, 122 Browsertests (Demo-Build und Alt-App, Chromium Desktop und
  Android-Emulation) sowie 18 Full-Stack-Tests je Projekt (Stand 27.10.2026).

### Sicherheit (QA 2026-10-28)
- B3: Firmenprofil (Branding, Kontakt, Einstellungen, Name) ändert nur noch der Inhaber. Plattformpersonal hat
  keinen Schreibzugriff mehr auf Mandantenzeilen, auch nicht mit Support-Freigabe; Statuswechsel nur über
  `set_tenant_status` (jetzt SECURITY DEFINER mit Super-Admin-Prüfung). Migration `0011_tenant_profile_owner_only.sql`.
- B4: Anmeldung eines gesperrten Kontos mit 2FA verrät die Sperre (und damit das richtige Passwort) nicht mehr
  vor dem zweiten Faktor; die 403-Meldung folgt erst nach dem richtigen Code.
- B5: Herkunft `source: "migration"` (Altdaten-Übernahme) nur noch für eigene Einträge der angemeldeten Person;
  Leitung kann Einträge anderer nicht als „Übernahme“ markieren (403).
- B6: CSV-Export der Arbeitszeiten (Chef-Portal) schützt vor Formel-Injektion: Freitexte, die mit `=`, `+`, `-`,
  `@`, Tab oder CR beginnen, erhalten ein vorangestelltes `'` (`platform/src/core/csv.ts`); Quelle „Übernahme“
  wird im Export ausgewiesen.
- B7: Stilllegen/Löschen von Mandanten dokumentiert (`docs/betrieb.md`, 6.1a); weiterhin kein API-Endpunkt.

### Bekannte Fehler der Alt-App (dokumentiert, nicht geändert)
- Überschneidung über Mitternacht wird nicht erkannt.
- Beschädigter Stundenspeicher kann beim nächsten Speichern überschrieben werden.
- Nicht existierende Daten (z. B. 30.02.) werden akzeptiert.
- Lücke vor einem Nachteinsatz zählt nicht als Pause (fachlich zu klären).

### Unverändert
- Produktive UWE-App (Version 27) im Repository-Stamm.

## Bestehende App
- Version 27 (26.10.2026): Monatsstunden für die Abrechnung nach Übertragung ins Arbeitszeitkonto.
- Ältere Versionen: siehe Git-Historie von `main`.
