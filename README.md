# UWE Stunden-App → Zeiterfassungsplattform

UWE Krankentransporte – Digitale Zeiterfassung für Mitarbeiter.

Dieses Repository enthält zwei Dinge:

1. **Die produktive UWE Stunden-App** (Repository-Stamm, Version 27), ausgeliefert über GitHub Pages:
   - Mitarbeiter-App: `index.html`
   - Test-Mitarbeiter: `test-mitarbeiter.html`
   - Chef-Verwaltung: `chef-mobil.html`
2. **Die neue mandantenfähige Plattform** (Ordner `platform/`, `db/`, `server/`), entwickelt auf dem
   Branch `develop`. Sie ersetzt die produktive App erst nach ausdrücklicher Freigabe.

## Schnellstart (Entwicklung)

```bash
npm ci
npm run dev            # Plattform mit Demo-Daten
npm run serve:legacy   # bestehende App lokal
npm test               # Unit- und Datenbanktests
npm run test:e2e       # Browsertests
```

## Dokumentation

| Thema | Datei |
|---|---|
| Ist-Analyse der bestehenden App | [docs/analyse-ist-zustand.md](docs/analyse-ist-zustand.md) |
| Architektur und Entscheidungen | [docs/architektur.md](docs/architektur.md) |
| Datenbank | [docs/database.md](docs/database.md) |
| Sicherheit und Datenschutz | [docs/security.md](docs/security.md) |
| API | [docs/api.md](docs/api.md) |
| Speicherinventar der Alt-App | [docs/legacy-storage.md](docs/legacy-storage.md) |
| Migrationsplan | [docs/migrationsplan.md](docs/migrationsplan.md) |
| Testplan | [docs/testplan.md](docs/testplan.md) |
| Deployment, Betrieb, Wiederherstellung | [docs/betrieb.md](docs/betrieb.md) |
| Mitarbeit, Branches, Versionen | [CONTRIBUTING.md](CONTRIBUTING.md) |
| Offene Aufgaben | [TASKS.md](TASKS.md) |
| Änderungen | [CHANGELOG.md](CHANGELOG.md) |
