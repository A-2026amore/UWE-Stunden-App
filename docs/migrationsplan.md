# Migrationsplan: bestehende UWE-App → Plattform

**Status:** vorbereitet und getestet mit simulierten Daten. Eine produktive Migration findet erst
nach ausdrücklicher Freigabe des Auftraggebers statt.

## Grundsätze

1. **Keine Datenlöschung.** Die Altdaten im `localStorage` der Handys werden bei der Migration nur
   gelesen, nie gelöscht oder umgeschrieben. Sie bleiben als Rückfall erhalten.
2. **Verlustfrei und nachvollziehbar.** Jeder gültige Alteintrag wird 1:1 übernommen. Ungültige
   Einträge werden mit Rohwert im Migrationsbericht aufgeführt, niemals stillschweigend verworfen.
3. **Idempotent.** Einträge behalten ihre Alt-ID (bzw. die deterministische `legacy-…`-ID der
   Alt-App). Eine wiederholte Migration erzeugt keine Duplikate.
4. **Parallelbetrieb.** Die Alt-App bleibt unverändert erreichbar, bis alle Mitarbeiter migriert und
   die Daten vom Arbeitgeber geprüft sind.
5. **Kein Formatwechsel ohne Rückweg.** Der neue Speicher nutzt eigene Schlüssel; die Alt-Schlüssel
   werden nicht verändert.

## Ablauf (je Mitarbeiter)

| Schritt | Wer | Was |
|---|---|---|
| 0 | Plattform | Mandant UWE anlegen, Einstellungen = bisherige Regeln, Mitarbeiter mit Personalnummern anlegen |
| 1 | Mitarbeiter | Backup in der Alt-App erstellen (zusätzliche Sicherung) |
| 2 | Mitarbeiter | Persönliche Einladung der neuen App öffnen, Passwort setzen |
| 3 | Neue App | Liest `uwe_hours_2_<Personalnummer>` und `uwe_arbeitszeitkonto_v1_<Personalnummer>` desselben Geräts (gleiche Herkunft `a-2026amore.github.io` erforderlich, siehe unten) **oder** importiert die Backup-Datei (v2–v4) |
| 4 | Neue App | Zeigt Migrationsbericht: Anzahl Einträge, Monatssummen alt/neu, übersprungene Duplikate, ungültige Einträge |
| 5 | Mitarbeiter | Bestätigt; Daten werden mit Quelle `migration` hochgeladen |
| 6 | Chef | Vergleicht Monatssummen im Chef-Portal mit den zuletzt eingereichten PDFs |
| 7 | Plattform | Erst nach Abschluss aller Mitarbeiter: Alt-App zeigt Hinweis auf neue App (separate Freigabe) |

**Herkunft (Origin):** `localStorage` ist an die Domain gebunden. Läuft die neue App unter einer
anderen Domain, kann sie die Altdaten nicht direkt lesen; dann ist der Weg über die Backup-Datei
(Schritt 3, Variante 2) zu gehen, oder es wird eine kleine Export-Seite unter der alten Domain
bereitgestellt. Das ist Teil der Produktivfreigabe.

## Rückfallweg

- Altdaten bleiben unverändert auf dem Gerät, die Alt-App funktioniert weiter.
- Der Migrationsimport ist pro Mitarbeiter rückgängig zu machen: Einträge mit `source = migration`
  können vom Plattformbetreiber nach Freigabe als gelöscht markiert (Soft Delete) und erneut
  importiert werden.
- Backup-Dateien der Alt-App bleiben gültig und können jederzeit erneut importiert werden.

## Tests

- `platform/src/core/migration.test.ts`: Verlustfreiheit, Idempotenz, Duplikate, ungültige Daten,
  Nachtschichten, Arbeitszeitkonto über zwei Schuljahre.
- `tests/fixtures/legacy-storage.ts`: simulierte Gerätedaten mehrerer Mitarbeiter.
- Ausstehend vor Produktivfreigabe: Test mit echten, vom Auftraggeber freigegebenen und
  pseudonymisierten Backup-Dateien; Test auf echten iPhones (Safari + Home-Bildschirm-App) und
  Android-Geräten, weil iOS Home-Bildschirm-Apps einen eigenen Speicher haben können.
