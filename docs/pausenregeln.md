# Fachregeln: Pausen

Stand: 28.10.2026 (Vorgabe des Auftraggebers: „Pausen dürfen nicht einfach als tatsächlich genommen
eingetragen werden, wenn sie nicht genommen wurden.“)

## Grundsatz: nur die tatsächlich genommene Pause

- Das Pausenfeld in der Mitarbeiter-App (`Arbeitszeit erfassen`) startet **leer**. Es gibt keinen
  automatischen Vorschlag mehr (früher: „Vorschlag automatisch eingetragen“) und keine Schnell-Buttons.
- Das Feld ist ein Pflichtfeld. `0` ist eine gültige Eingabe, wenn keine Pause nötig ist.
- Der Hinweis unter dem Feld nennt die nötige Mindestpause für den Tag (Summe aller Einsätze des Datums)
  und die Regel, aus der sie folgt, z. B.
  „Für diesen Tag (8,00 Std. Einsatzzeit) sind mindestens 30 Minuten Pause vorgeschrieben (Regel: mehr als
  6 Stunden). Trage nur die Pause ein, die du tatsächlich genommen hast.“
- Reicht die eingetragene Pause nicht, wird **nicht gespeichert**. Die Meldung nennt die fehlenden Minuten
  und rät: keine Pause eintragen, die nicht genommen wurde; bei einer Unterbrechung den Tag als mehrere
  Einsätze erfassen; sonst Beginn/Ende prüfen oder mit der Leitung sprechen.
- Beim **Bearbeiten** eines gespeicherten Einsatzes steht die damals eingetragene Pause im Feld (das ist
  der erfasste Wert, kein Vorschlag). Dasselbe gilt für die **Korrektur im Chef-Portal**
  (`Arbeitszeiten → Korrigieren`): Feld mit dem erfassten Wert, Hinweis auf die Mindestpause des Tages,
  zu kurze Pause wird mit Erklärung abgelehnt.
- Geprüft wird an drei Stellen mit derselben Logik (`platform/src/core/breaks.ts`): im Formular, in der
  Offline-Warteschlange vor dem Einreihen und verbindlich in der API (nach dem Schreiben in derselben
  Transaktion, Fehler `400 break_rule`). Die Datenbank erzwingt zusätzlich Pause ≥ 0 und < Dauer.
- `suggestedPause` bleibt in der Fachlogik nur für die Vergleichstests mit der Alt-App erhalten und wird
  in keiner Oberfläche mehr verwendet.

## Die zwei Regeln

§ 4 Arbeitszeitgesetz: bei **mehr als** 6 Stunden mindestens 30 Minuten, bei **mehr als** 9 Stunden
mindestens 45 Minuten Pause; Pausenteile unter 15 Minuten zählen nicht.

Schwellen in `settings.breakPolicy.thresholds` sind inklusiv (`Einsatzzeit ≥ minGrossMinutes`):

| Regel | Schwellen | Text in App, Chef-Portal | Wer |
|---|---|---|---|
| Gesetzlich (`statutory`) | 361 → 30, 541 → 45 | „mehr als 6 Stunden“ / „mehr als 9 Stunden“ | Standard für neue Mandanten (Entscheidung des Auftraggebers vom 28.10.2026) |
| Streng (`strict`) | 360 → 30, 540 → 45 | „ab 6 Stunden“ / „ab 9 Stunden“ | UWE (Mandant `demo-krankentransporte` in Seed und Demo, Alt-App) |

Beispiele: genau 6:00 h ohne Pause ist bei der gesetzlichen Regel gültig, bei der strengen nicht;
6:01 h braucht bei beiden 30 Minuten; genau 9:00 h braucht gesetzlich 30, streng 45 Minuten; 9:01 h
braucht bei beiden 45 Minuten.

Alle Texte werden aus der Konfiguration gebildet (`thresholdLabel`, `breakRuleSummary`,
`requiredPauseText`): Schwelle auf voller Viertelstunde → „ab …“, eine Minute darüber → „mehr als …“.
Die Pausentexte der Alt-App (`issueForDay`, „Es fehlen noch … Minuten gültige Pause“) bleiben wörtlich
gleich (Vergleichstests). Der PDF-Monatsnachweis enthält keine Regeltexte, nur die eingetragene Pause je
Einsatz – dort war nichts anzupassen.

## Einstellung im Chef-Portal

`Einstellungen → Pausenregeln` zeigt die aktive Regel als Satz und Tabelle. Der **Inhaber** wählt
„Gesetzlich (mehr als 6 / 9 Stunden)“ oder „Streng (ab genau 6 / 9 Stunden)“; die Änderung wird bestätigt,
gilt für neue und geänderte Einträge und steht im Änderungsprotokoll. Gespeicherte Einträge werden nicht
verändert (nach einem Wechsel auf „streng“ können sie in der Monatsprüfung als Pausenproblem erscheinen).
Vorgesetzte sehen die Regel nur lesend. Eine individuell gesetzte Regel wird als „Individuell“ angezeigt.

## Nie laxer als das Gesetz

Strengere Werte sind erlaubt, laxere nicht. Eine Regel deckt das Gesetz ab, wenn
- eine Schwelle mit `minGrossMinutes ≤ 361` und `minPauseMinutes ≥ 30` existiert,
- eine Schwelle mit `minGrossMinutes ≤ 541` und `minPauseMinutes ≥ 45` existiert,
- `minPauseSegmentMinutes ≥ 15`.

Durchgesetzt in `validateBreakPolicy`/`statutoryBreakProblems` (API `PATCH /api/tenants/:id/settings`,
Demo-Repository) und in der Datenbank (Migration `0014_break_policy_statutory.sql`, CHECK
`tenants_break_policy_statutory` → `23514`, gilt auch für Superuser-Schreibzugriffe). Bestehende Zeilen
werden bei der Migration geprüft; falls eine laxere Regel existiert, bleibt der Constraint `NOT VALID`
und die Migration meldet die Mandanten als Warnung (es werden keine Daten automatisch geändert).

## Standard an einer Stelle ändern

Die Regel für neue Mandanten steht in `platform/src/core/breaks.ts`:
`NEW_TENANT_BREAK_RULE` (`"statutory"` oder `"strict"`). Entscheidet der Auftraggeber anders, wird dort
der Wert geändert und `private.default_tenant_settings()` in einer neuen Migration angeglichen;
`tests/db/break-policy.test.ts` schlägt fehl, solange beide nicht übereinstimmen. Bestehende Mandanten
behalten ihre gespeicherte Regel.

Hinweis: Die Schwellen beziehen sich – wie in der Alt-App – auf die erfasste Einsatzzeit des Tages
(brutto). Das Gesetz stellt auf die Arbeitszeit ab; da die Einsatzzeit nie kürzer als die Arbeitszeit ist,
ist das mindestens so streng wie das Gesetz. Eine arbeitsrechtliche Prüfung steht aus (keine Rechtsberatung).
