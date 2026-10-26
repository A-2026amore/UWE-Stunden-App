# Aufgaben

Legende: [x] erledigt · [~] in Arbeit · [ ] offen · [!] wartet auf Entscheidung des Auftraggebers

## Phase 1 – Analyse
- [x] Repository vollständig gelesen, Ist-Analyse (`docs/analyse-ist-zustand.md`)
- [x] Speicherinventar der Alt-App (`docs/legacy-storage.md`)

## Phase 2 – Projektvorbereitung
- [x] Branch `develop`, Werkzeuge, CI, Vorlagen, Grunddokumentation
- [!] Claude GitHub App für das Repository installieren (Upload/Push)
- [ ] Branch-Schutz für `main` aktivieren (benötigt Admin-Rechte in den Repository-Einstellungen)

## Phase 3 – Design
- [x] Designsystem mit White-Label, Oberflächen Mitarbeiter/Chef/Super-Admin (Demo)

## Phase 4 – Architektur
- [x] Entscheidung: eigener Server in Deutschland (26.10.2026)
- [x] PostgreSQL-Schema mit RLS und Mandantentrennungstests
- [x] Node-API (Anmeldung, Sitzungen, Daten unter RLS)
- [x] Fachlogik übernommen und gegen Altcode abgesichert

## Phase 5–9 – Apps, Firmenprofile, Super-Admin, Synchronisierung
- [x] Demo-Betrieb aller drei Bereiche
- [x] Offline-Speicher und Synchronisierung in der Mitarbeiter-App
- [x] Übernahme der Altdaten (Backup/Browser-Speicher) mit Bericht
- [ ] Service Worker der Plattform (Offline-Start), getrennt vom Alt-Service-Worker
- [ ] Seiten „Passwort neu setzen“ und „Einladung annehmen“
- [ ] Zwei-Faktor-Anmeldung (TOTP)
- [ ] Apps im Produktionsbuild an die API anbinden (Demo bleibt für Staging)

## Phase 10–12 – Absicherung, Staging, Pull Request
- [x] Tests der Alt-App (Unit + Browser)
- [ ] Echte Geräte: iPhone Safari/PWA, Android Chrome/PWA (Checkliste `docs/testplan.md`)
- [!] Staging-Adresse: separater kostenloser Hosting-Dienst oder zweites Repository
- [ ] Pull Request `develop` → `main` zur Abnahme (kein Merge ohne Freigabe)

## Offene Entscheidungen / Risiken für den Auftraggeber
- [!] Öffentliches Repository enthält Vornamen mit Personalnummern (`chef-mobil.html`). Privat machen
  erfordert für GitHub Pages einen kostenpflichtigen GitHub-Tarif – Entscheidung nötig.
- [!] Arbeitsrechtliche Prüfung: Pausenregel „ab genau 6/9 Stunden“, Schuljahreskonto –100 h.
- [!] Server mieten und AV-Vertrag, sobald die Plattform produktionsreif ist.
- [ ] Vor Merge nach `main`: `.nojekyll` bzw. Pages-Konfiguration prüfen, damit `docs/` und
  `platform/` nicht ungewollt veröffentlicht werden.
