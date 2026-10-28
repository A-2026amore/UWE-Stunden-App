# Testplan UWE Stunden-App (Alt-App und Migration)

Stand: 26.10.2026. Dieser Plan beschreibt, wie die produktive Alt-App (Repo-Root) abgesichert wird, bevor und
während sie in die neue Plattform migriert wird. Grundsatz: **Nichts gilt als getestet, was nicht tatsächlich
ausgeführt wurde.** Echte Personendaten werden nie verwendet; alle Testdaten sind erfunden, alle Schlüssel sind
im Test erzeugte Testschlüssel (nie der produktive Schlüssel aus `uwe-config.js`).

## 1. Teststufen

| Stufe | Werkzeug | Ort | Zweck |
|---|---|---|---|
| Unit (Alt-Code) | Vitest, Projekt `unit` | `tests/legacy/**/*.test.ts` | Fachregeln der Alt-Module direkt prüfen (Pausen, Schuljahreskonto, PDF, Sperrliste, Eintrags-Normalisierung) |
| Fixture-Prüfung | Vitest | `tests/legacy/fixtures.test.ts` | Migrations-Fixtures werden vom unveränderten Alt-Code genau so gelesen wie dokumentiert |
| DB / RLS | Vitest, Projekt `db` | `tests/db/**` (anderes Team) | Mandantentrennung, Row-Level-Security, Migrationsimport idempotent – **noch ausstehend** |
| E2E Alt-App | Playwright | `tests/e2e/legacy/**` | echte Bedienung im Browser gegen `http://127.0.0.1:4173` (statischer Server aus `playwright.config.ts`) |
| E2E Plattform | Playwright | `tests/e2e/platform/**` (anderes Team) | neue App auf Port 4174 |
| Mobile-Emulation | Playwright-Projekte `mobile-android` (Pixel 7), `mobile-iphone` (iPhone 14/WebKit) | wie E2E | Viewport, Touch, mobile User-Agent |
| Echte Geräte | manuell | Checkliste Abschnitt 5 | iPhone-Safari/PWA und Android-Chrome-Besonderheiten, die Emulation nicht abbildet |

### Technik der Unit-Tests

Die Alt-Module sind IIFEs, die sich an `window` hängen. `tests/legacy/support/load-legacy.ts` liest die Originaldateien
und führt sie in einem Node-`vm`-Kontext aus (mit `window`, In-Memory-`localStorage`, `TextEncoder`, `Blob`, `File`,
WebCrypto, abschaltbarem `fetch` und optional eingefrorenem `Date`). Die nicht exportierten Eintrags-Hilfsfunktionen
(`valid`, `normalizeEntries`, `overlaps` …) werden wortgleich aus dem Inline-Skript von `index.html` bzw.
`test-mitarbeiter.html` herausgeschnitten und ebenso ausgeführt. Am Alt-Code wird nichts verändert.
`tests/legacy/support/pdf-inspect.ts` prüft erzeugte PDFs strukturell (Header, xref-Offsets, Stream-Längen,
Trailer, Seitenzahl, Textinhalte).

### Technik der E2E-Tests

- **Zeit eingefroren:** `page.clock.install({ time: 2026-11-20 10:00 Europe/Berlin })` – die App benutzt das aktuelle
  Datum (Vorbelegung, Ablaufprüfung, Schuljahr). Für den 45-s-Cache der Sperrprüfung wird `page.clock.fastForward` genutzt.
- **Dialoge:** alle `alert`/`confirm` werden über `page.on("dialog")` mitgeschrieben und bestätigt (bzw. gezielt abgelehnt).
- **Echter Login (`index.html`):** Testschlüsselpaar ECDSA P-256 wird im Test erzeugt; `**/uwe-config.js` wird per
  `page.route` durch den Test-Public-Key ersetzt, `uwe-access-control.json` wird vom Test geliefert (steuerbare
  Sperrliste, HTTP-Fehler), `api.github.com` ist blockiert. Einladungscodes werden genau wie `chef-mobil.js`
  `signCredential` gebaut (`tests/fixtures/legacy-invite.ts`: Payload `{v,eid,name,exp,salt,pinHash}`, PBKDF2 100 000 SHA-256).
- **Downloads:** Backup-JSON und PDF werden über das Download-Ereignis gespeichert und inhaltlich geprüft.
- **Abgeschnittene Netzwerkzugriffe:** keine echten Aufrufe ins Internet.

## 2. Ausführen

```bash
# Unit (Alt-Code + Fixtures)
npx vitest run --project unit tests/legacy

# E2E Alt-App lokal (nur Chromium installiert; WebKit fehlt lokal)
PW_PLATFORM=0 npx playwright test tests/e2e/legacy --project desktop-chromium --project mobile-android

# Bekannte Alt-Fehler sichtbar als echte Fehlschläge statt "expected to fail"
SHOW_LEGACY_BUGS=1 PW_PLATFORM=0 npx playwright test tests/e2e/legacy --project desktop-chromium -g "LEGACY BUG"
```

In CI (mit installiertem WebKit) zusätzlich `--project mobile-iphone`. `playwright install` wird lokal nicht ausgeführt.

## 3. Ergebnis des letzten Laufs (26.10.2026, lokal)

| Lauf | Ergebnis |
|---|---|
| `npx vitest run --project unit tests/legacy` | 5 Dateien, **141 Tests bestanden** (davon 2 `it.fails` = dokumentierte Alt-Fehler, die wie erwartet fehlschlagen) |
| Playwright `desktop-chromium` + `mobile-android` | **82 bestanden** (41 Tests × 2 Projekte; davon 2 × 2 `test.fail` = dokumentierte Alt-Fehler) |
| Stabilität | 3 Wiederholungen (`--repeat-each 3`): 246/246 bestanden, keine flakigen Tests |
| `mobile-iphone` (WebKit) | **nicht ausgeführt** (WebKit lokal nicht installiert) |
| ESLint und `tsc --strict` über alle neuen Testdateien | ohne Befund |

## 4. Abdeckung

### 4.1 Automatisch abgedeckt (ausgeführt)

**Pausenregeln (`uwe-break-rules.js`, 34 Unit-Tests)**
- 6:00 h → 30 min, 5:59 h → 0, 9:00 h → 45, 8:59 h → 30 (Grenzen inklusive)
- mehrere Einsätze pro Tag summiert; Lücken ≥ 15 min zählen als Pause und werden nicht doppelt abgezogen; Lücken < 15 min und Pausenstücke < 15 min zählen nicht
- Einzeleinsatz > 12 h abgelehnt (12:00 h genau erlaubt), Tagessumme > 12 h abgelehnt, Überschneidung abgelehnt (auch mit Nachtschicht desselben Datums), Berühren erlaubt
- Nachtschicht 22:00–06:00, `suggestedPause` (0/30/45, Lücken, mind. 15 min, Bearbeiten schließt sich selbst aus, ungültige Eingaben → `null`), `issueForDay`, `errorsForMonth`

**Arbeitszeitkonto (`uwe-arbeitszeitkonto.js`, 39 Unit-Tests)**
- offizielle NRW-Tabelle 2026–2030; 2026/27 = 02.09.2026 bis 16.07.2027; Folgejahre; unbekannte Jahre → `null`/„Termin offen“; Online-Cache nur bei plausiblen Daten, offline keine erfundenen Termine
- −100 h (−6000 min) Startsaldo je Schuljahr; neues Schuljahr wieder −100 h, Vorjahressaldo bleibt
- Beispiel 50 h geleistet − 20 h übertragen = 30 h Abrechnung (Saldo −80 h); erneute Aufteilung ersetzt (keine Doppelbuchung); nur Schulzeitstunden (Juli 2027: Ferientage ausgeschlossen, 01.09.2026 ausgeschlossen); Ferienmonate geschlossen
- `validate`: fremde Personalnummer, falsche Version, manipulierter Startsaldo, ungültige Monate/Werte, kaputtes JSON → abgelehnt; Format v1 → v2

**PDF (`uwe-pdf.js`, 11 Unit-Tests + 1 E2E)**
- beginnt mit `%PDF-`, xref-Offsets/Stream-Längen/Trailer korrekt (Prüfer erkennt nachweislich defekte xref)
- 60 Einträge → mehrere Seiten (≥ 3), jede Seite mit Kopf, Tabellenkopf, „Seite x von n“, jeder Eintrag genau einmal
- Name, Personalnummer, Monat, Summen, Arbeitszeitkonto-Abschnitt; Testkennzeichnung auf jeder Seite; Umlaute/€ als WinAnsi; Klammern escaped
- inkonsistente Kontozahlen/ungültige Einträge werden abgelehnt statt falsch gedruckt

**Sperrliste (`uwe-access-check.js`, 6 Unit-Tests)** – Sperre ohne Groß-/Kleinschreibung, ungültige Liste = Fehler, offline = gesperrt („fail closed“), 404-Rückfall GitHub-API, Cache.

**Eintrags-Normalisierung (aus `index.html`)** – Gültigkeit, stabile `legacy-`IDs (FNV-1a), Duplikatbehandlung, Feldbereinigung, Überschneidung nur am selben Datum.

**Migrations-Fixtures (Unit + 6 E2E)** – alle 10 Snapshots werden vom Alt-Code wie dokumentiert gelesen (Anzahl gültig/verworfen, Monatsminuten, abgeleitete IDs, instabile IDs, Kontosalden je Schuljahr, Fehler); Zugangscodes korrekt signiert und PIN-Hash passend; Chef-Umschläge mit Testpasswort entschlüsselbar; Backups v2–v4 bestehen die Importprüfung; im echten `index.html` geladen zeigen sie die erwarteten Summen.

**E2E `test-mitarbeiter.html` (20 Tests × Desktop-Chromium und Android-Emulation)**
- Eintrag anlegen, ändern, löschen (Bestätigen und Abbrechen)
- zwei Einsätze am selben Tag mit Tagessumme, Monatssumme, Monatswechsel
- Nachtschicht 22:00–06:00
- Überschneidung, Einsatz > 12 h, Tagessumme > 12 h, fehlende Pause → abgelehnt (Dialogtext geprüft, nichts gespeichert)
- automatischer Pausenvorschlag (45 min bei 10 h, Lücke zwischen Einsätzen wird berücksichtigt)
- Arbeitszeitkonto 50 → 20 → 30 h im Monatspanel, Überschreiben 10 h, Obergrenze, Persistenz; Sommerferien gesperrt
- Backup herunterladen (v4-Inhalt geprüft) und in **frischem Browser-Kontext** wiederherstellen, erneuter Import ohne Duplikate; fremdes Backup abgelehnt
- PDF-Download: `.pdf`, `%PDF`-Header, gültige Struktur, mehrere Seiten bei 40 Einträgen, Test-Kennzeichnung; PDF-Export bei Pausenverstoß blockiert
- Daten bleiben nach Neuladen erhalten; Testmodus schreibt keine echten Mitarbeiterschlüssel

**E2E `index.html` mit echtem Login (14 Tests × 2)**
- Login über `?code=`-Link (Code verschwindet aus der Adresszeile) und über eingefügten Link
- falsche PIN, falsches PIN-Format, abgelaufener Code (Code mit Ablauf = heute gültig), fremde Signatur, manipulierter Payload, Müll
- Sitzung überlebt Neuladen; Stunden unter `uwe_hours_2_<eid>`; Abmelden behält Stunden
- Sperre während der Nutzung (nach Ablauf des 45-s-Caches) und beim nächsten Start: Abmeldung, `uwe_session` gelöscht, **Stunden bleiben**, erneuter Login verweigert
- Sperrliste nicht erreichbar (HTTP 500 / 404 + GitHub blockiert) → Login verweigert; offline wird nichts gespeichert, nichts geht verloren
- ohne Public Key → Einrichtungsseite

### 4.2 Noch offen (nicht automatisiert / nicht ausgeführt)

| Thema | Grund / nächster Schritt |
|---|---|
| `mobile-iphone` (WebKit) | lokal nicht installiert – in CI ausführen. Ersetzt **nicht** den Test auf echtem iPhone |
| `chef-mobil.html` (Entsperren mit Sicherung, Einladung erstellen, Massen-Einladung, Mitarbeiterverzeichnis, Sperr-Vormerkung, Zwischenablage, WhatsApp-Link) | noch keine E2E-Tests; Fixtures (`chefDevice`, Testpasswort) liegen bereit |
| PDF teilen (`navigator.share`), PDF-Vorschau (neues Fenster), Drucken, CSV-Export | nur Download getestet; Web Share nur auf echten Geräten sinnvoll |
| Service Worker / Offline-Betrieb / Update-Knopf | `sw.js` registriert sich nur unter HTTPS – lokal nicht abgedeckt |
| Online-Ferienabruf (OpenHolidays) ab 2031 | nur Cache-Auswertung und Offline-Verhalten getestet, kein Netzwerk-Mock des echten API-Formats im Browser |
| Sichtbarkeitswechsel/2-Minuten-Intervall der Sperrprüfung | nicht getestet |
| DB/RLS, Migrationsimport in die neue Plattform | gehört zur Plattform; Fixtures `tests/fixtures/legacy-storage.ts` sind dafür vorbereitet |
| Barrierefreiheit, visuelle Regression | nicht im Umfang |

## 5. Pflicht: Tests auf echten Geräten

Emulation (Chromium mit Pixel-7-Profil, WebKit-Desktop mit iPhone-Profil) bildet folgende Punkte **nicht** ab.
Vor jeder Umstellung mindestens auf einem aktuellen iPhone (iOS, Safari **und** als Home-Bildschirm-App) und einem
Android-Gerät (Chrome **und** installierte PWA) prüfen, mit Testmitarbeiter und Testschlüssel:

1. **Installation als PWA** (Teilen → Zum Home-Bildschirm / Chrome „App installieren“): Start, Icon, Titel. Auf iOS hat die
   Home-Bildschirm-App einen **eigenen Speicher** – Login und Daten aus Safari sind dort nicht vorhanden (Hinweis in der App prüfen).
2. **Einladungslink aus WhatsApp öffnen** (In-App-Browser von WhatsApp vs. Safari/Chrome), Login mit PIN, Sitzung nach App-Neustart.
3. **Datums-/Zeit-Picker** (iOS-Räder, Android-Dialoge), Zahlentastatur für PIN und Pause, Dezimal-Komma im Arbeitszeitkonto.
4. **PDF per WhatsApp / E-Mail** über das Teilen-Menü (`navigator.share` mit Datei): Datei kommt als `.pdf`-Dokument an,
   mehrseitig lesbar; Verhalten bei Abbruch. „PDF anzeigen“ (Pop-up-Blocker), „PDF speichern“ (Dateien-App/Downloads).
5. **Backup herunterladen und wiederherstellen** über Dateien-App/Google Drive; Import nach Neuinstallation.
6. **Offline / schlechtes Netz:** Start ohne Netz (gecachte App), Speichern wird verweigert, nichts geht verloren; Rückkehr online.
7. **Speicherlöschung:** iOS löscht Website-Daten nach längerer Nichtnutzung bzw. bei „Verlauf löschen“ – Verhalten dokumentieren,
   Backup-Hinweis prüfen. Android: „Websitedaten löschen“.
8. **App-Update** über „App aktualisieren“ und automatische SW-Aktualisierung; Daten bleiben erhalten.
9. **Hintergrund/Vordergrund:** Sperrprüfung beim Zurückkehren in die App (visibilitychange).
10. **Chef-App** auf iPhone: Sicherungsdatei auswählen, „Gerät merken“, Zwischenablage, WhatsApp-Einladung.

Ergebnisse je Gerät/OS-Version mit Datum im Testprotokoll festhalten.

## 6. Gefundene Fehler in der Alt-App (dokumentiert, **nicht** behoben)

Alle sind als erwartete Fehlschläge hinterlegt (`it.fails` / `test.fail`); sobald jemand den Alt-Code korrigiert,
schlagen diese Tests „unerwartet erfolgreich“ fehl und müssen in normale Tests umgewandelt werden.

| # | Fehler | Reproduktion | Test |
|---|---|---|---|
| L1 | **Überschneidung über Mitternacht mit dem Folgetag wird nicht erkannt.** Nachtschicht 12.11. 22:00–06:00 und Einsatz 13.11. 05:00–09:00 werden beide gespeichert (1 h doppelt). Auch die 12-h-Tagesgrenze wird nicht datumsübergreifend geprüft. | Testmodus: beide Einsätze nacheinander speichern → kein Hinweis | `tests/e2e/legacy/test-mitarbeiter.spec.ts` „LEGACY BUG: overlap with a night shift…“, Unit `fixtures.test.ts` (`overlaps`) |
| L2 | **Unlesbare gespeicherte Stunden werden beim nächsten Speichern überschrieben.** Ist `uwe_hours_2_<eid>` kein gültiges JSON, zeigt die App 0 Einträge; der nächste gespeicherte Einsatz ersetzt den Rohbestand endgültig. | Snapshot `unparsable` laden, Einsatz speichern | `tests/e2e/legacy/fixtures-in-legacy-app.spec.ts` „LEGACY BUG: unparsable…“ |
| L3 | **Unmögliche Kalenderdaten werden akzeptiert.** `valid()` nutzt `Date.parse`, das in Chromium/V8 z. B. `2026-02-30` annimmt. Über Backup-Import/gespeicherte Daten gelangen solche Einträge in Summen und PDF. Manuelle Eingabe ist durch das Datumsfeld geschützt. | Backup mit `"date":"2026-02-30"` importieren | `tests/legacy/fixtures.test.ts` „LEGACY BUG: valid() should reject…“ |
| L4 | **Lücke vor einem Nachtblock desselben Datums zählt nicht als Pause** (Klärung nötig). 06:00–10:00 und 22:00–02:00 am selben Datum: 12 h Abstand, trotzdem werden 30 min Pause verlangt. Widerspricht der Regel „Lücken ≥ 15 min zwischen Einsätzen zählen als Pause“. | `evaluateDay` mit beiden Blöcken → `missing: 30` | `tests/legacy/break-rules.test.ts` „LEGACY BUG? gap before an overnight block…“ |

Weitere Beobachtungen (kein Testfehlschlag, aber für die Migration wichtig):

- Gleiche Schicht einmal mit und einmal ohne ID wird **doppelt gezählt**; doppelte explizite IDs erhalten bei jedem Laden eine neue Zufalls-ID (Fixture `duplicates`).
- Backup-Import ersetzt Einträge mit gleicher ID ohne Pausen-/Überschneidungsprüfung.
- Testmodus-Konto liegt unter `uwe_arbeitszeitkonto_v1_TEST001` – gleiches Schema wie echte Konten.
- Personalnummer im Speicherschlüssel ist groß-/kleinschreibungsabhängig, die Sperrprüfung nicht.
- Der Zugangscode enthält Salt und PIN-Hash; 6–12-stellige PINs sind damit offline angreifbar.

## 7. Abnahmekriterien für die Migration

- Alle Snapshots aus `tests/fixtures/legacy-storage.ts` werden importiert, ohne dass eine Minute verloren geht
  (Vergleich mit `snapshotMeta.netMinutesByMonth`), verworfene Rohdaten werden gesichert und gemeldet.
- Schuljahressalden stimmen mit `snapshotMeta.workAccount` überein.
- Backups v2–v4 (`legacyBackups`) sind importierbar, mehrfacher Import ist idempotent.
- Testdaten landen nicht im Echtbestand; gesperrte Mitarbeiter verlieren keine Stunden.
- Alle Tests dieses Plans grün (bekannte Alt-Fehler L1–L4 in der neuen Plattform als **behoben** nachgewiesen).
- Gerätetest-Checkliste (Abschnitt 5) auf echtem iPhone und Android-Gerät abgehakt.

## 8. Plattform: Offline-Synchronisierung, Altdaten-Import und E2E (Demo-Build)

Stand 26.10.2026, lokal ausgeführt (Chromium „desktop-chromium“ und „mobile-android“; WebKit/iPhone lokal nicht installiert).

### 8.1 Unit-Tests

| Datei | Inhalt |
|---|---|
| `platform/src/data/sync.test.ts` (20 Tests) | Sync-Schicht mit Speicher im Arbeitsspeicher und Demo-Repository als „Server“: 2× offline erfassen → nach `flush()` genau 2 Server-Einträge, wiederholtes `flush()` ohne Duplikate; Netzabbruch **nach** Speicherung auf dem Server (Antwort verloren) und **vor** Erreichen des Servers → Wiederholung ohne Duplikate; verlorene Antwort bei Änderung wird als „bereits übernommen“ erkannt (kein falscher Konflikt); Reihenfolge Ändern/Löschen; Löschen eines nie gesendeten Eintrags sendet nichts; Outbox übersteht Neuladen und Abmelden; Lesen offline aus dem Cache; Pausenregel/Überschneidung/Arbeitszeitkonto lokal vor dem Einreihen geprüft; Versionskonflikt behält Server-Version und lokale Änderung („meine Version“ / „Server-Version“); vom Server abgelehnte Änderung wird als Konflikt aufbewahrt, nie verworfen; sofortige Ablehnung online geht an das Formular zurück; `AccessDeniedError` stoppt die Übertragung, Outbox bleibt; Monatsnachweis erst nach vollständiger Übertragung; ID eines auf dem Server gelöschten Eintrags wird nicht still wiederbelebt; fremde Mitarbeiter/Mandanten werden nicht gecacht und bleiben gesperrt. |
| `platform/src/apps/employee/legacyImport.test.ts` (7 Tests) | Import-Planung mit `tests/fixtures/legacy-storage.ts`: Backup v2/v3/v4, Bericht vor dem Schreiben (gelesen, zu übernehmen, vorhanden, Duplikate, ungültig, nicht übernehmbar), Monatssummen alt/neu (Oktober 7,50 h, November 30,75 h), Aufteilungen, idempotenter Re-Import, fremde Personalnummer abgelehnt, Testmodus-Backup abgelehnt, Browser-Snapshot nur eigene Personalnummer, kaputte/überlappende Einträge mit Begründung. |

### 8.2 E2E-Tests `tests/e2e/platform/` (19 Tests × 2 Projekte = 38)

Ausführen: `npx playwright test tests/e2e/platform --project desktop-chromium --project mobile-android`
(die Konfiguration baut die Plattform und startet die Vorschau auf `http://127.0.0.1:4174`).

Determinismus: jeder Test läuft in einem frischen Browser-Kontext (leerer `localStorage` → neue Demo-Daten);
`page.clock.setFixedTime` friert „heute“ auf Fr 20.11.2026 10:00 ein (Import-Tests: 15.03.2027), Timer laufen normal.
Prüfungen gegen den „Server“ lesen die Demo-Datenbank (`stundenwerk_demo_db_v1`) direkt aus.

| Datei | Abgedeckt |
|---|---|
| `employee.spec.ts` | Startseite (drei Bereiche, Demo-Zugänge); falsches Passwort; Mitarbeiterin: Einsatz anlegen mit Pausenregel-Meldung (7 h ohne Pause → „Es fehlen noch 30 Minuten …“, Speichern verweigert), bearbeiten, löschen (Soft Delete), Monatssumme = Summe der Tagessummen = Summe in der Datenbank; Arbeitszeitkonto (Mandant ohne Freigabepflicht): 50 % übertragen → Abrechnung = geleistet − übertragen, geleistete Stunden unverändert, Monatsseite identisch, zu hohe Übertragung abgelehnt; PDF-Download (`%PDF-`, mehr als eine Seite bei > 20 Einsätzen); Monatsnachweis einreichen sperrt den Monat. |
| `offline.spec.ts` | Echte Offline-Phase (`context.setOffline`): 2 Einsätze offline, Anzeige „2 Änderungen warten auf Übertragung“, nichts auf dem Server; nach Wiederverbindung automatische Übertragung (Ereignis `online`), genau 2 Einträge, erneutes Synchronisieren ohne Duplikate. Entwicklerschalter „Offline simulieren“: Outbox übersteht Neuladen, Einreichen offline verweigert, nach Ausschalten übertragen. Konflikt: offline geändert, gleichzeitig Server-Korrektur → Konflikt-Dialog zeigt beide Versionen, „Meine Version behalten“ schreibt Version 3, nichts still überschrieben. |
| `legacy-import.spec.ts` | Backup v4 per Dateiauswahl (`filechooser`): Bericht vor dem Schreiben (6 gelesen/6 zu übernehmen, Monatssummen, Aufteilungen), vor Bestätigung nichts geschrieben, nach Bestätigung 6 Einträge + 2 Aufteilungen, Monatsseite zeigt 30,75 h; Re-Import v4 und v3 → 0 zu übernehmen. Fremde Personalnummer und kaputte Datei abgelehnt. Import aus den Alt-Schlüsseln desselben Browsers (geteiltes Gerät): nur eigene Personalnummer, Alt-Schlüssel danach byte-gleich, Re-Import idempotent. |
| `pause.spec.ts` | Pausenfeld startet leer (kein Vorschlag), Hinweis nennt Mindestpause und Regel („ab 6 Stunden“ bei UWE, „mehr als 6 Stunden“ beim gesetzlichen Mandanten); leeres Feld und zu kurze Pause → nicht gespeichert, freundliche Meldung; 0 Minuten bei genau 6 h (gesetzlich) gespeichert; Inhaber schaltet im Chef-Portal zwischen „streng“ und „gesetzlich“ um, Texte und Mitarbeiter-App folgen; Korrekturdialog im Chef-Portal nennt die Mindestpause und lehnt zu kurze Pause ab. |
| `chef-tenants-admin.spec.ts` | Chef: Dashboard-Kennzahlen (7 Mitarbeitende, 6 aktiv/1 eingeladen, 1 offener Nachweis), keine Personen des anderen Mandanten; Zurückgeben nur mit Begründung (leere Begründung → Fehlermeldung), Mitarbeiter sieht die Begründung; Freigeben. Firmenfarbe + WhatsApp-Nummer ändern → in der Mitarbeiter-App desselben Mandanten sichtbar (CSS-Variable `--brand-primary`, `wa.me`-Link), beim anderen Mandanten unverändert. Zwei Mandanten: unterschiedliche Logos und Telefonnummern. Mandantentrennung: Mitarbeiterin von Mandant B öffnet `#/erfassen/<ID eines Eintrags von Mandant A>` → „Kein Zugriff“, Eintrag unverändert; Leitung von B sieht keine Personen von A. Super-Admin: Badge „Kostenlos – Pilot“ nur beim Pilotmandanten, Mandantendetail ohne Namen/Zeiten und „Keine Freigabe“; nach Freigabe durch den Inhaber „Freigabe durch den Mandanten aktiv“. |

Ergebnis: 38 von 38 bestanden. Stabilität mit `--repeat-each 3` (114 Läufe) dreimal geprüft: zweimal 114/114, einmal
2 Fehlschläge desselben Tests („create with pause rule …“, `toBeVisible`, unter paralleler Last, Ursache nicht ermittelt,
danach nicht reproduzierbar, auch nicht mit 8 Wiederholungen und 4 Workern) – als möglicher Flake beobachten.

### 8.3 Nicht abgedeckt / Grenzen

- Diese Tests laufen gegen das Demo-Repository (Browser). Die echte API + PostgreSQL deckt Abschnitt 9 ab.
- Offline-Start nach Neuladen ohne Netz: seit dem Service Worker der Mitarbeiter-App im Full-Stack-Test geprüft
  (Abschnitt 9); auf echten Geräten (Abschnitt 5) weiterhin Pflicht.
- Mandantentrennung wird hier nur über die Oberfläche bzw. die Demo-Prüfungen gezeigt; die verbindliche Grenze ist RLS in
  der Datenbank (`tests/db`).
- WebKit/iPhone nicht lokal ausgeführt; Gerätetests nach Abschnitt 5 bleiben Pflicht.

## 9. Full-Stack: Plattform im API-Modus gegen echte API und PostgreSQL

Stand 26.10.2026, lokal ausgeführt (nur Chromium).

```bash
npx playwright test -c playwright.fullstack.config.ts --project desktop-chromium
npx playwright test -c playwright.fullstack.config.ts --project mobile-android
```

Aufbau (`playwright.fullstack.config.ts`, `tests/e2e/fullstack/`, Dateien `*.fullstack.ts` – die normale
`playwright.config.ts` nimmt sie nicht mit):

1. `support/global-setup.ts` baut die Plattform einmal mit `VITE_DATA_MODE=api` in ein temporäres Verzeichnis
   (oder nutzt `FULLSTACK_DIST`).
2. Worker-Fixture `support/stack.ts` je Projekt: Wegwerf-PostgreSQL 16 über `tests/db/support/harness.ts`
   (Migrationen + Seed), Passwörter mit dem Betriebsbefehl `server/src/cli.ts set-password`, API als eigener
   Node-Prozess wie in Produktion (`server/src/main.ts`, `STATIC_DIR` = API-Build, `PUBLIC_ORIGIN` = eigene Adresse).
   E-Mails werden aus dem Entwicklungs-Mailer-Log (ohne SMTP) gelesen.
3. Automatische CSP-Prüfung: jede Konsolenmeldung „Content Security Policy“ lässt den Test fehlschlagen.
   Prüfungen gegen den Server lesen die Datenbank direkt (Superuser-Verbindung nur für Assertions).

| Datei | Abgedeckt |
|---|---|
| `employee.fullstack.ts` (8) | Echte Anmeldung ohne Demo-Zugänge/-Hinweise, falsches Passwort; Einsatz anlegen → Zeile in `time_entries` (Version 1, Herkunft `app`) → lokalen Speicher löschen + Neuladen → Einsatz kommt vom Server; offline erfassen (`context.setOffline`) → 0 Zeilen → Wiederverbindung → genau 1 Zeile, erneutes Synchronisieren ohne Duplikat, kein Schalter „Offline simulieren“; Sitzung serverseitig beendet → Speichern führt zur Anmeldung mit „Deine Sitzung ist abgelaufen …“, nichts verloren, nach Anmeldung genau 1 Zeile; gesperrter Mandant → deutsche Meldung beim Anmelden; Service Worker: Bereich `/app/`, nur Caches `stundenwerk-app-*`, keine `/api/`- und keine Chef-Dateien im Cache, nach Löschen aller Caches (wie durch die Alt-App) beim nächsten Start wieder vollständig, Neuladen ohne Netz öffnet die App; neue Version → „Neue Version verfügbar – neu laden“ → Seite lädt neu, eigener alter Cache ersetzt, fremder Cache bleibt; fremde Zeiten per API → 403. |
| `chef-admin.fullstack.ts` (4) | Mitarbeiter reicht November ein → Leitung sieht den Einsatz unter „Arbeitszeiten“, gibt den Nachweis mit Begründung zurück → DB `returned` + `review_note`, Mitarbeiter sieht die Begründung; Inhaberin von Mandant B sieht keine Personen von A, API-Aufrufe mit IDs von A → 403; Super-Admin sieht Mandanten und Lizenzen, keine Namen/Zeiten, Zeit-Endpunkte → 403, Systemstatus „Erreichbar“; Mandantenkonto im Admin-Portal abgewiesen. |
| `links.fullstack.ts` (3) | Passwort vergessen → Mail-Link `/passwort-neu#token=…` → Token verschwindet aus der Adresszeile → Wiederholung falsch → neues Passwort → Link ein zweites Mal ungültig → altes Passwort falsch, neues richtig; Einladung durch die Leitung → Hinweis „steht mit Link im Server-Log“ → Link `/einladung#token=…` → zu kurzes Passwort abgelehnt → Konto aktiv, Anmeldung; Einladung an eine E-Mail mit bestehendem Konto (anderer Mandant) → „Ich habe bereits ein Konto“ → Text der API, altes Passwort gilt weiter, zwei Mitgliedschaften. |

Ergebnis: desktop-chromium 15/15, mobile-android 15/15; zusätzlich `--repeat-each 3` auf desktop-chromium 45/45.

Weitere neue automatische Tests: `tests/server/static.test.ts` (6: `STATIC_DIR`, CSP, Cache-Header, Weiterleitung,
Traversal/versteckte Dateien/Symlinks, Einladungsantwort ohne Token), `platform/src/data/api.test.ts` (401 →
Sitzung abgelaufen, `tenant_suspended`, Netzfehler wird von der Sync-Schicht als Netzfehler erkannt,
Einladungs-Zustellinfo), `platform/src/data/sync.test.ts` (anderes Konto zwischenzeitlich angemeldet → nichts wird
unter diesem Konto gesendet), `platform/src/apps/employee/serviceWorker.test.ts` (Registrierung nur Produktion + HTTPS/localhost).

Nicht abgedeckt: echter SMTP-Versand (nur Entwicklungs-Log), Betrieb hinter Caddy/TLS (`Secure`-Cookie,
`__Host-sid`, HSTS) – nur ohne TLS auf `127.0.0.1` getestet; WebKit/iPhone; Vite-Entwicklungs-Proxy
(`VITE_DEV_API_PROXY`) nicht ausgeführt.

## 10. Zwei-Faktor-Anmeldung (TOTP)

Stand 27.10.2026, lokal ausgeführt (nur Chromium).

| Datei | Abgedeckt |
|---|---|
| `platform/src/security/totp.test.ts` (33) | Base32 (RFC-4648-Vektoren, Kleinbuchstaben/Leerzeichen, ungültige Zeichen), SHA-1/HMAC-SHA-1 (FIPS-180/RFC-2202-Vektoren), HOTP (RFC 4226 Anhang D), TOTP (RFC 6238 Anhang B, SHA-1, 8 Stellen), Toleranzfenster ±1, Code-Normalisierung, Wiederherstellungscodes (Format, Alphabet), `otpauth://`-URI |
| `platform/src/security/qrcode.test.ts` (12) | QR-Encoder: Rücklesen der Matrix mit eigenem Decoder inkl. Reed-Solomon-Prüfung für alle Fehlerkorrekturstufen und mehrere Versionen, Formatbits, Ausrichtungsmuster, feste Prüfsumme einer Matrix (zusätzlich einmalig mit OpenCV dekodiert, nicht Teil der automatischen Tests) |
| `platform/src/data/demo.test.ts` (2 neue) | Demo-Repository: Einrichtung mit echtem TOTP-Code, zweistufige Anmeldung, kein Replay, Wiederherstellungscode nur einmal; Mandanten-Pflicht nur mit eigener 2FA, Vorgesetzte sehen danach nur die Einrichtung |
| `platform/src/data/api.test.ts` (1 neuer) | Client: `twoFactorRequired` → `TwoFactorRequiredError`, Verify, 403 `two_factor_setup_required` |
| `tests/db/two-factor.test.ts` (9) | `app_user`/`app_anon` ohne Zugriff auf die drei Tabellen und Funktionen; RLS aktiv; nur Chiffrat-Format; Challenge ≤ 10 min; Codes nur als Hash; `last_used_step` nicht rückwärts; Pflicht (Plattform immer, Leitung nur bei aktiver Mandanten-Pflicht, nicht bei deaktiviertem Mitarbeiter/gesperrtem Mandanten); nur Inhaber ändert die Einstellung; Audit-Ereignisse je Mandant, für Plattformkonten ohne Mandant |
| `tests/server/two-factor.test.ts` (19) | Einrichtung (URI, verschlüsselte Speicherung, AAD = Benutzer, falscher/richtiger Code, 10 Codes, andere Sitzungen beendet, Audit); Anmeldung: Passwort-Schritt ohne Sitzung, HttpOnly-Cookie 5 min, falsches Passwort wie unbekanntes Konto, Challenge einmalig, max. 5 Versuche, Replay und Codes außerhalb ±1 abgelehnt; Wiederherstellungscodes einmalig, Neuerzeugung ungültig macht alte; Deaktivieren nur mit Passwort + Code; Plattformkonten nur Einrichtung erreichbar; Mandanten-Pflicht; Rate-Limit mit 429/`Retry-After`; Schlüssel-Parsing, Produktion ohne Schlüssel bricht ab, Rotation mit Neuverschlüsselung |
| `tests/e2e/platform/two-factor.spec.ts` (1 × 2 Projekte) | Demo-Build: Einrichtung in den Einstellungen mit Code aus dem angezeigten Geheimnis, Anmeldung mit „Demo: aktuellen Code einsetzen“, Anmeldung mit Wiederherstellungscode |
| `tests/e2e/fullstack/two-factor.fullstack.ts` (3) | Echte API + PostgreSQL: Mitarbeiterin richtet 2FA ein (QR, Geheimnis, falscher Code, Download `wiederherstellungscodes.txt`), DB enthält nur Chiffrat/Hashes, neuer Browser: Passwort → kein Zugriff → falscher Code → richtiger Code; Wiederherstellungscode einmal gültig, zweites Mal abgelehnt; Audit; Support-Konto sieht nur die Pflicht-Einrichtung (auch nach Neuladen, API 403) bis zur Einrichtung; Inhaberin kann die Pflicht erst nach eigener Einrichtung einschalten |

Ergebnis: `npm run test:unit` 284/284, `npm run test:db` 209/209, Playwright Demo + Alt-App (desktop-chromium,
mobile-android) 122/122, Full-Stack desktop-chromium 18/18 und mobile-android 18/18.

Nicht abgedeckt: echte Authenticator-Apps auf echten Geräten (nur berechnete Codes; QR-Code einmalig mit OpenCV
dekodiert), WebKit/iPhone, Betrieb mehrerer API-Instanzen (Rate-Limits im Prozessspeicher), Zurücksetzen durch den
Betrieb per SQL (nur dokumentiert, nicht automatisch getestet).
