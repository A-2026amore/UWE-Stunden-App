# CLAUDE.md – Arbeitsanweisungen für dieses Repository

## Projekt
Zeiterfassung für UWE – Krankentransporte GmbH (Aachen), wird zur mandantenfähigen SaaS-Plattform
ausgebaut. Auftraggeber: Arif Bilgen. Kommunikation mit dem Auftraggeber auf Deutsch, kurz und
verständlich; technische Details selbst entscheiden.

## Harte Grenzen
- Repository-Stamm = produktive App auf GitHub Pages (aus `main`). Diese Dateien nicht ändern ohne
  Freigabe; niemals direkt auf `main` pushen oder mergen. GitHub-Pages-Einstellungen nicht ändern.
- Keine echten Mitarbeiterdaten in Code, Tests, Seeds, Screenshots. Repository ist öffentlich.
- Keine Geheimnisse committen. Keine kostenpflichtigen Dienste abschließen.
- Fachregeln nicht eigenmächtig ändern: Pausen ab genau 6 h ≥ 30 min, ab genau 9 h ≥ 45 min,
  > 12 h nicht speichern; Arbeitszeitkonto UWE: je NRW-Schuljahr Start –100 h, Schuljahr vom ersten
  Schultag nach bis zum letzten Schultag vor den Sommerferien; Monatsübertragung mindert nur die
  Abrechnungsstunden, geleistete Stunden bleiben dokumentiert. Ferientermine nie erfinden.
- PDF-Nachweise mehrseitig und gut lesbar – nie alles auf eine Seite quetschen.
- Produktive Migration, Deployment, Merge nach `main`: nur nach Freigabe.

## Struktur
- `platform/src/core` reine Fachlogik (Minuten als Ganzzahlen), Vergleichstests gegen Altcode
- `platform/src/data` Repository-Schnittstelle; Demo (Browser) und API
- `platform/src/design`, `platform/src/apps/{employee,chef,admin}` Oberflächen (Preact)
- `db/migrations` PostgreSQL-Schema mit RLS; `server/` Node-API (eigener Server, kein Supabase)
- `tests/legacy`, `tests/e2e`, `tests/db`, `tests/fixtures`

## Befehle
`npm run lint`, `npm run typecheck`, `npm run test:unit`, `npm run test:db`,
`npm run test:e2e` (lokal nur Chromium: `--project desktop-chromium --project mobile-android`),
`npm run build`, `npm run dev`.

## Konventionen
Code und Commits Englisch, UI und Doku Deutsch. Jede Änderung: Tests, Doku, CHANGELOG.
Nicht getestete Funktionen nie als geprüft bezeichnen.
