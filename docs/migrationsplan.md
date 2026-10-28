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

## Import-Oberfläche in der Mitarbeiter-App (Demo-Build umgesetzt)

Pfad: **Profil → „Daten aus der bisherigen UWE-App übernehmen“** (`#/einstellungen/import`,
Code `platform/src/apps/employee/pages/LegacyImport.tsx`, Logik `platform/src/apps/employee/legacyImport.ts`).

1. **Quelle wählen**
   - *Sicherungsdatei* (Backup v2–v4, JSON) über die Dateiauswahl → `parseLegacyBackup` (core).
   - *Daten aus diesem Browser lesen*: alle `uwe_*`-Schlüssel derselben Herkunft werden **nur gelesen**; übernommen werden
     ausschließlich `uwe_hours_2_<Personalnummer>` und `uwe_arbeitszeitkonto_v1_<Personalnummer>` der angemeldeten
     Person → `migrateLegacySnapshot` (core). Daten anderer Personalnummern werden im Bericht genannt, nicht übernommen.
     Testmodus-Schlüssel werden nicht übernommen.
2. **Personalnummer-Prüfung**: Die Personalnummer der Sicherung (`eid`) muss exakt der Personalnummer des angemeldeten
   Mitarbeiters entsprechen, sonst wird der Import mit Begründung abgelehnt (ebenso beschädigte Dateien und Testmodus-Backups).
3. **Bericht vor dem Schreiben**: gelesene Einträge, zu übernehmen, bereits in der neuen App vorhanden, Duplikate in den
   Altdaten, ungültige Einträge (mit Grund und Rohwert), nicht automatisch übernehmbare Einträge (z. B. Überschneidung,
   fehlende Pause, Monat bereits eingereicht/freigegeben, gleiche ID mit abweichendem Inhalt – nichts wird überschrieben),
   Monatssummen *bisherige App* / *neue App bisher* / *neue App nach Übernahme*, Arbeitszeitkonto-Aufteilungen, Hinweise.
   Vergleich mit dem Bestand über `entriesToImport` (core) und dieselben Regeln wie bei der Erfassung.
4. **Bestätigung** im Dialog, danach Schreiben über `createTimeEntry` (mit der Alt-ID als Idempotenzschlüssel und
   `source: "migration"`) und `setAllocation` (nur Monate ohne vorhandene Aufteilung). Die Schreibvorgänge laufen über die
   Offline-Synchronisierung (Outbox) – auch offline möglich, Übertragung später ohne Duplikate.
5. **Ergebnis**: Anzahl übernommener Einsätze/Aufteilungen, Fehlschläge mit Grund. Ein erneuter Import derselben oder
   einer älteren Sicherung zeigt „Nichts zu übernehmen“.

Alt-Schlüssel werden **nie** geändert oder gelöscht (E2E prüft den Inhalt vor/nach dem Import).

Offene Punkte:
- `source: "migration"` wird über `NewTimeEntry.source` übertragen und im Demo-Repository gespeichert (E2E prüft es).
  Die echte API muss das Feld ebenfalls übernehmen, damit der Rückfallweg „Soft Delete aller `source = migration`“ greift.
- Alt-IDs wie `legacy-79r8q4` sind keine UUIDs; die API muss diese IDs als Client-ID akzeptieren (Demo: bis 64 Zeichen).
- Ein früher importierter und danach gelöschter Eintrag wird bei erneutem Import nicht wieder angelegt (gleiche ID,
  Server antwortet idempotent mit dem gelöschten Eintrag). Der Bericht vor dem Schreiben zählt ihn noch als
  „zu übernehmen“ (die Liste gelöschter Einträge ist für Mitarbeitende nicht abrufbar); im Ergebnis erscheint er als
  nicht übernommen mit Begründung.
