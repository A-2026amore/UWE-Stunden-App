# Changelog

Format nach [Keep a Changelog](https://keepachangelog.com/de/1.1.0/), Versionen nach SemVer.

## [Unveröffentlicht] – Plattform 0.1.0 (Branch `develop`)

### Hinzugefügt
- Entwicklungswerkzeuge: Vite, TypeScript, Preact, Vitest, Playwright, ESLint.
- GitHub Actions: Lint, Typecheck, Unit-, Datenbank- und Browsertests, Build-Artefakt,
  Geheimnis-Scan, CodeQL, Dependabot; Pull-Request- und Issue-Vorlagen.
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
- Tests: 231 Unit-, 175 Datenbank-/API- und 120 Browsertests (Chromium Desktop, Android-Emulation).

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
