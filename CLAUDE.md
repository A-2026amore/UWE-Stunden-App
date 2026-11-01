# CLAUDE.md – Arbeitsanweisungen für dieses Repository

## Projekt
Mandantenfähige SaaS-Zeiterfassung (`platform/`, `server/`, `db/`), hervorgegangen aus der bisherigen
Stunden-App im Repository-Stamm. Alle Firmen sind normale Kunden – auch UWE –, keine firmenspezifische
Logik, Vorgaben oder Marken im Plattform-Code (Entscheidung 01.11.2026). Auftraggeber: Arif Bilgen. Kommunikation mit dem Auftraggeber auf Deutsch, kurz und
verständlich; technische Details selbst entscheiden.

## Harte Grenzen
- Repository-Stamm = produktive App auf GitHub Pages (aus `main`). Diese Dateien nicht ändern ohne
  Freigabe; niemals direkt auf `main` pushen oder mergen. GitHub-Pages-Einstellungen nicht ändern.
- Keine echten Mitarbeiterdaten in Code, Tests, Seeds, Screenshots. Repository ist öffentlich.
- Keine Geheimnisse committen. Keine kostenpflichtigen Dienste abschließen.
- Fachregeln nicht eigenmächtig ändern. Pausenregel und Arbeitszeitkonto sind Einstellungen je Firma:
  Pausen gesetzlich (§4 ArbZG, mehr als 6 h ≥ 30 min, mehr als 9 h ≥ 45 min) oder wahlweise streng (ab
  genau 6 h / 9 h), nie laxer als das Gesetz; Höchstdauer je Firma (neue Firmen 10 h, höchstens 12 h).
  Arbeitszeitkonto standardmäßig aus; wahlweise Kalenderjahr oder NRW-Schuljahr (vom ersten Schultag nach
  bis zum letzten Schultag vor den Sommerferien) mit Startsaldo je Firma. Monatsübertragung mindert nur die
  Abrechnungsstunden, geleistete Stunden bleiben dokumentiert. Ferientermine nie erfinden.
  Die Regeln der alten App (`LEGACY_BREAK_POLICY`, `LEGACY_WORK_ACCOUNT_POLICY`) gibt es nur für
  Vergleichstests und die Altdaten-Übernahme, nie als Vorgabe.
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
