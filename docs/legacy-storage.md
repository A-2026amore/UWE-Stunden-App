# Speicherinventar der Alt-App (UWE Stunden-App v27)

Stand: 26.10.2026 · Quelle: Code im Repo-Root (`index.html`, `test-mitarbeiter.html`, `chef-mobil.js`,
`chef-staff.js`, `uwe-arbeitszeitkonto.js`, `uwe-access-check.js`, `sw.js`) sowie die Git-Historie
(Backup-Formate v2–v4, Kontoformat v1).
Simulierte Gerätestände für Migrationstests: `tests/fixtures/legacy-storage.ts` (alle Daten erfunden),
deren Auslegung durch den unveränderten Alt-Code wird in `tests/legacy/fixtures.test.ts` und
`tests/e2e/legacy/fixtures-in-legacy-app.spec.ts` geprüft.

Die Alt-App benutzt ausschließlich `localStorage` (gebunden an die Origin, z. B.
`https://a-2026amore.github.io`). `sessionStorage`, IndexedDB und Cookies werden nicht benutzt.
Der Service Worker nutzt zusätzlich die Cache Storage (nur App-Dateien, keine Nutzdaten).

## 1. Übersicht aller Schlüssel

| Schlüssel | Geschrieben von | Inhalt | Format/Version | Migration |
|---|---|---|---|---|
| `uwe_session` | `index.html` (Login) | signierter Zugangscode des angemeldeten Mitarbeiters | Klartext-String `<payload>.<signatur>` | Personalnummer/Name auslesen, **nicht** als Login weiterverwenden |
| `uwe_hours_2_<eid>` | `index.html` | Arbeitszeiten eines Mitarbeiters | JSON-Array, Einträge ohne/mit ID (siehe 3) | **muss vollständig überleben** |
| `uwe_arbeitszeitkonto_v1_<eid>` | `index.html`, `test-mitarbeiter.html` | Monatsaufteilungen ins Schuljahreskonto | JSON-Objekt, `version` 1 oder 2 | **muss überleben** |
| `uwe_test_hours_v1_only` | `test-mitarbeiter.html` | Arbeitszeiten des Testmodus (TEST001) | wie `uwe_hours_2_*` | **nicht** als echte Arbeitszeit migrieren |
| `uwe_nrw_sommerferien_v2` | `uwe-arbeitszeitkonto.js` | Cache Online-Ferientermine ab 2031 | `{"2031":{"start","end"}}` | optional (nur Cache) |
| `uwe_nrw_sommerferien_v1` | erste Fassung des Kontomoduls (26.10.2026, ca. 13:07–13:20 Uhr) | veralteter Ferien-Cache | `{"2031":"2031-07-14"}` | wird nicht mehr gelesen, ignorieren |
| `uwe_chef_remembered_encrypted_backup_v1` | `chef-mobil.js` | verschlüsselte Sicherung des privaten Chef-Signaturschlüssels | JSON-Umschlag v1 | **nicht** migrieren (Schlüssel bleibt beim Chef) |
| `uwe_staff_directory_salt_v1` | `chef-staff.js` | PBKDF2-Salt für das Mitarbeiterverzeichnis | Base64 (16 Byte) | nur zum Entschlüsseln |
| `uwe_staff_directory_encrypted_v1` | `chef-staff.js` | verschlüsseltes Mitarbeiterverzeichnis | JSON-Umschlag v1 (AES-GCM) | Stammdaten-Import nach Entschlüsselung |

Platzhalter `<eid>` = Personalnummer genau so, wie sie im Zugangscode steht (`[A-Za-z0-9_-]{1,30}`,
Groß-/Kleinschreibung relevant; die Sperrprüfung vergleicht dagegen ohne Groß-/Kleinschreibung).

Nicht im `localStorage`, aber für die Migration relevant:

- `uwe-access-control.json` (Server-Datei im Repo): `{ "version": 1, "updatedAt": "YYYY-MM-DD", "revoked": ["<eid>", …] }`.
  Wird bei jedem Start und vor jeder Änderung mit `cache: "no-store"` geladen (45 s Zwischenspeicher im Speicher);
  bei 404 Rückfall auf die GitHub-Contents-API. Offline/ungültig ⇒ keine Änderungen möglich („fail closed“).
- `uwe-config.js`: `window.UWE_ACCESS_PUBLIC_KEY` = öffentlicher ECDSA-P-256-Schlüssel (JWK).
- PINs werden **nirgends** gespeichert; nur der PBKDF2-Hash steckt im Zugangscode.
- Cache Storage des Service Workers: `uwe-stunden-v27-netto-monatsstunden-20261026` (wird bei neuer Version gelöscht).

## 2. `uwe_session`

- Wert: Zugangscode `base64url(JSON payload) + "." + base64url(ECDSA-Signatur)`.
- Payload: `{ "v": 1, "eid": "E1001", "name": "…", "exp": "YYYY-MM-DD", "salt": "<base64url 16 Byte>", "pinHash": "<hex, PBKDF2-SHA-256, 100000 Iterationen, 256 Bit>" }`.
- Signatur: ECDSA P-256 / SHA-256 über die **base64url-Zeichenkette** des Payloads (nicht über das JSON).
- Geschrieben nach erfolgreichem Login (Signatur, Ablaufdatum, PIN, Online-Sperrprüfung).
  Gelöscht bei Abmelden, bei Sperre (`UWE_REVOKED`) und beim Öffnen eines neuen `?code=`-Links.
- Nur **eine** Sitzung pro Gerät; Stunden anderer Mitarbeiter auf demselben Gerät bleiben unter ihrem eigenen Schlüssel liegen.
- `exp` wird als Text mit dem lokalen Datum verglichen; ein Code mit `exp` = heute ist noch gültig.
- Sicherheitshinweis: Der Code enthält Salt und PIN-Hash. Wer den Code hat, kann 6–12-stellige PINs offline
  durchprobieren (PBKDF2 100 000 Iterationen bremst nur). Für die neue Plattform nicht übernehmen.

## 3. Arbeitszeiten `uwe_hours_2_<eid>` (und `uwe_test_hours_v1_only`)

Aktuelles Format (seit v3, 24.10.2026):

```json
[{ "id": "3f1c2b9e-6a4d-4c1b-9f2e-1a2b3c4d5e01", "date": "2026-11-02", "start": "06:30", "end": "14:30", "pause": 30, "note": "Schülertour" }]
```

| Feld | Regel in der Alt-App |
|---|---|
| `id` | `crypto.randomUUID()`; Fallback `e<zeit36>-<16 hex>`; für Alteinträge `legacy-<FNV-1a(date\|start\|end\|pause\|note) base36>`. Gültig, wenn `^[a-zA-Z0-9_-]{4,100}$` |
| `date` | `YYYY-MM-DD`, Datum des **Arbeitsbeginns** (Nachtschicht 22:00–06:00 zählt komplett zum Starttag/-monat) |
| `start`, `end` | `HH:MM` (24 h). `end < start` ⇒ über Mitternacht. `start == end` ungültig |
| `pause` | ganze Minuten ≥ 0, < Einsatzdauer. Als Text gespeicherte Zahl (`"15"`) wird akzeptiert |
| `note` | Freitext (Eingabefeld max. 200 Zeichen, im Speicher nicht erzwungen) |

Nettostunden = `(end − start [+24 h]) − pause`. Es gibt kein gespeichertes Summenfeld.

Historie:

| Zeitraum | App-Stand | Besonderheit |
|---|---|---|
| bis 24.10.2026 | v2-Ära | **keine `id`**, ein Eintrag pro Datum (Speichern am selben Tag hat überschrieben) |
| ab 24.10.2026 | v3+ | IDs, mehrere Einsätze pro Tag, Bearbeiten/Löschen je Eintrag |
| ab 26.10.2026 | v26/v27 | unverändertes Eintragsformat, zusätzlich Arbeitszeitkonto |

Lesen (`normalizeEntries`, bei jedem Start): ungültige Elemente werden **still verworfen**, zusätzliche
Felder entfernt, fehlende IDs deterministisch als `legacy-…` erzeugt, exakte Duplikate ohne ID
zusammengeführt. Doppelte **explizite** IDs bleiben beide erhalten; das zweite Element bekommt bei
**jedem Laden eine neue Zufalls-ID** (nicht stabil). Zurückgeschrieben wird erst beim nächsten
Speichern/Löschen/Import – bis dahin bleibt der Rohbestand unverändert.

Prüfungen beim manuellen Speichern (nicht beim Laden/Import!): Format, Einsatz ≤ 12 h,
Überschneidung am **selben Datum**, Tagessumme ≤ 12 h, Pausenregel (ab 6:00 h 30 min, ab 9:00 h 45 min,
Pausenstücke < 15 min zählen nicht, Lücken ≥ 15 min zwischen Einsätzen zählen als Pause).

## 4. Arbeitszeitkonto `uwe_arbeitszeitkonto_v1_<eid>`

Aktuelles Format (Daten-`version` 2, der Schlüsselname heißt trotzdem `_v1_`):

```json
{ "version": 2, "eid": "E1001", "openingMinutes": -6000, "startMonth": "2026-09", "allocations": { "2026-10": 300, "2026-11": 600 } }
```

- `allocations`: Monat `YYYY-MM` (≥ `2026-09`) → ins Konto übertragene **Minuten** (ganzzahlig, 0 < x ≤ 600 000).
  Pro Monat genau ein Wert; erneutes Speichern **ersetzt** (keine Doppelbuchung), 0 löscht den Monat.
- Salden werden **nicht gespeichert**, sondern berechnet: je NRW-Schuljahr −6000 min (−100 h) + Summe der Aufteilungen
  der Monate dieses Schuljahres. Neues Schuljahr ⇒ wieder −100 h, Vorjahr bleibt sichtbar.
- Schuljahr = erster Tag nach den Sommerferien bis letzter Werktag (Mo–Fr) vor den nächsten Sommerferien.
  Offizielle Tabelle im Code 2026–2030 (z. B. 2026/27: 02.09.2026 – 16.07.2027); ab 2031 nur aus
  `uwe_nrw_sommerferien_v2`, sonst „Termin offen“ (keine geratenen Daten).
- Anrechenbar sind nur Stunden an Schultagen; Ferienmonate sind gesperrt.
- Version 1 (erste Fassung vom 26.10.2026, nur wenige Minuten veröffentlicht – Bestand unwahrscheinlich, aber möglich): `{ "version": 1, …, "startMonth": "2026-11", "initialDeadline": "2027-07-19", "allocations": {…} }`.
  Wird beim Laden akzeptiert und beim nächsten Speichern als Version 2 geschrieben (0-Werte entfallen).
- Beim Laden abgelehnt (Konto-UI gesperrt, Export blockiert): fremde `eid`, andere `version`,
  `openingMinutes ≠ −6000`, ungültige Monate/Werte, kaputtes JSON.
- Testmodus schreibt `uwe_arbeitszeitkonto_v1_TEST001` – **gleiches Schema wie echte Mitarbeiter**
  (nur die Personalnummer trennt Test- von Echtdaten).

## 5. Chef-Seite

`uwe_chef_remembered_encrypted_backup_v1` („Dieses Gerät merken“):

```json
{ "app": "UWE Stunden Chef", "version": 1, "publicJwk": { … }, "salt": "<base64url>", "iv": "<base64url 12 Byte>", "secret": "<base64url>" }
```

`secret` = AES-GCM-256 (Schlüssel aus PBKDF2-SHA-256, 250 000 Iterationen, Chef-Passwort, `salt`) über das
JSON des **privaten** Signatur-JWK. Entspricht 1:1 der Sicherungsdatei, die der Chef einmalig auswählt.

`uwe_staff_directory_salt_v1`: Base64 (Standard, mit `+/=`) von 16 Zufallsbytes, einmalig pro Gerät erzeugt.

`uwe_staff_directory_encrypted_v1`:

```json
{ "version": 1, "iv": "<base64>", "data": "<base64 AES-GCM>" }
```

Entschlüsselt (PBKDF2-SHA-256, 250 000 Iterationen, Chef-Passwort + obiger Salt):
`[{ "name", "eid", "exp": "YYYY-MM-DD"|null, "issuedAt": ISO|null, "desiredActive": true|false|null, "source": "issued"|"verified"|"manual" }]`
(max. 1000, Personalnummer eindeutig ohne Groß-/Kleinschreibung). `desiredActive` = vorgemerkte, noch nicht
veröffentlichte Sperre/Freigabe. PINs werden nicht gespeichert.

## 6. Backup-Dateien (vom Mitarbeiter heruntergeladen)

Dateiname `UWE-Backup-<eid>-<YYYY-MM-DD>.json` (Testmodus `UWE-TEST-Backup-…`).

| Version | gültig ab | Inhalt |
|---|---|---|
| 2 | 23.10.2026 | `{ app: "UWE Stunden", version: 2, eid, name, exportedAt, entries: [ohne id] }` |
| 3 | 24.10.2026 | wie v2, `entries` mit `id` |
| 4 | 26.10.2026 | wie v3 + `arbeitszeitkonto` (validiertes Kontoobjekt, siehe 4) |

Testmodus: `app: "UWE Stunden Test"` – nur in `test-mitarbeiter.html` importierbar und umgekehrt.

Wiederherstellen (aktuelle Alt-App) akzeptiert v2, v3 und v4, wenn `app` passt, `eid` **exakt** gleich ist und
**alle** Einträge gültig sind (ein ungültiger Eintrag ⇒ ganzer Import abgelehnt). Zusammenführung: gleiche ID ⇒
Backup-Eintrag ersetzt den vorhandenen; sonst gleicher Fingerabdruck (`date|start|end|pause|note`) ⇒ übersprungen;
sonst neu. v4: Monatsaufteilungen aus dem Backup überschreiben die vorhandenen Monate. Keine Pausen-/
Überschneidungsprüfung beim Import. Mehrfacher Import desselben Backups erzeugt keine Duplikate (E2E-getestet).

CSV- und PDF-Export sind Berichte, keine Sicherung (nicht wieder importierbar).

## 7. Was eine Migration sicherstellen muss

1. **Keine Stunde geht verloren:** alle Elemente aus allen `uwe_hours_2_*` des Geräts (auch die, die die Alt-App
   still verwirft) als Rohdaten sichern; gültige Einträge mit Originalwerten übernehmen.
2. **IDs stabil halten:** vorhandene IDs übernehmen; für ID-lose Einträge dieselbe `legacy-<FNV-1a>`-ID bilden,
   damit spätere Importe alter Backup-Dateien idempotent bleiben. Doppelte explizite IDs gesondert behandeln.
3. **Nachtschichten** bleiben dem Starttag/-monat zugeordnet (Monatssummen und Schuljahreskonto hängen daran).
4. **Arbeitszeitkonto:** Aufteilungen je Monat übernehmen (v1 → v2), Salden je Schuljahr neu berechnen
   (−100 h je Schuljahr, Vorjahre bleiben). Fremde/defekte Konten nicht übernehmen, sondern zur Klärung markieren.
5. **Mehrere Mitarbeiter je Gerät:** jeden `uwe_hours_2_<eid>` getrennt nach Personalnummer zuordnen, unabhängig
   davon, wessen `uwe_session` gerade gespeichert ist; Stunden gesperrter Mitarbeiter **behalten**.
6. **Testdaten** (`uwe_test_hours_v1_only`, `…_TEST001`) nie als echte Arbeitszeit übernehmen.
7. **Backups v2–v4** müssen dauerhaft importierbar bleiben (Fallback, wenn die Origin wechselt oder das Handy weg ist).
8. Alt-Daten erst löschen, wenn die Übernahme bestätigt ist (siehe `docs/migrationsplan.md`).

Bekannte Risiken im Bestand (Details und Tests in `docs/testplan.md`): Duplikate (gleiche Schicht mit und ohne ID wird
doppelt gezählt), Überschneidungen über Mitternacht mit dem Folgetag, unmögliche Daten wie `2026-02-30` (V8 akzeptiert
sie), defektes JSON (die Alt-App zeigt 0 Einträge und überschreibt beim nächsten Speichern), iOS kann
Website-Daten nach längerer Nichtnutzung löschen.
