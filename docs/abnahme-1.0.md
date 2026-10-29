# Abnahmebericht Stundenwerk 1.0 (Stand 29.10.2026, 01:00)

Branch `release/1.0`, Draft-PR #7 (nicht mergen). Alle Daten in Tests und Screenshots sind erfunden.
Ausführlicher Prüfbericht der unabhängigen Schlussprüfung: `/mnt/project-files/berichte/schluss-pruefung-1.0.md`.

## 1. Was funktioniert

| Bereich | Stand |
|---|---|
| Mitarbeiter-App (PWA) | Anmeldung (Passwort, optional 2FA), mehrere Einsätze pro Tag, Pausenprüfung ohne Vorbelegung, automatische Summen, Tages-/Monatsansicht mit Tagesdiagramm, Korrekturanfragen, PDF-Stundennachweis (mehrseitig, neues Layout), Firmenlogo/-name, Offline-Erfassung mit Synchronisierung, Installationshinweis iPhone/Android, Datenauskunft, hell/dunkel |
| Chef-Portal | Dashboard mit Kennzahlen und Diagramm; Mitarbeiter anlegen, einladen, sperren, deaktivieren; Stundenübersicht; Freigabe/Rückgabe von Monatsnachweisen; **Wiederöffnung nur mit Begründung und erneuter Freigabe**, Verlauf je Nachweis; Korrekturanfragen; PDF/CSV; Firmenprofil; Pausenregel; Abrechnung/Kosten; Datenschutz; Handy-Menü |
| Mehrmandanten | Trennung in PostgreSQL (Row Level Security); automatischer Test ruft **jede** API-Route mit fremden Konten auf |
| Super-Admin | Firmen anlegen (auch kostenlos), freischalten, sperren, deaktivieren; Umsatz je Monat, Abrechnungsstatus, Sonderkonditionen, Standardpreis; **Rechnungen** mit lückenlosen Nummern `SW-JJJJ-000001`, Storno mit eigener Nummer, Rechnungs-PDF; Systemübersicht; Protokoll; Vertragsende (Gesamtexport, Löschung per Server-Konsole) |
| Preismodell | 5,00 € netto je aktivem Mitarbeiter/Monat; Leitung ohne eigene Zeiten kostenlos; Gesperrte/Deaktivierte und gesperrte Firmen ab Folgemonat 0 €; Gratis-Konten; abgeschlossene Monate festgeschrieben; Monat mit gültiger Rechnung nur nach Storno änderbar; Zahlungsdienst nur vorbereitet |
| Design | Name „Stundenwerk“, eigenes Logo, einheitliches Design in allen drei Bereichen, hell/dunkel/System, zweigeteilte Anmeldeseiten, Schrift lokal (keine Fremd-Server) |
| Sicherheit | scrypt-Passwörter, sichere Sitzungs-Cookies, CSRF-/Herkunftsprüfung, CSP, Anmelde-Limits, 2FA (Pflicht für Plattformkonten), Audit-Log |
| Backups | verschlüsseltes Datenbank-Backup mit Prüfsumme, Wiederherstellungsprobe in eine leere Datenbank (läuft in der CI und lokal) – siehe `docs/backup-bericht-1.0.md` |

## 2. Tests (release/1.0, lokal, 29.10.2026)

| Prüfung | Ergebnis |
|---|---|
| Lint, Typecheck | sauber |
| Unit | 398/398 |
| Datenbank + Server (inkl. Mandantentrennung, Backup/Restore lokal) | 393/393 |
| Browser Demo (Desktop-Chromium + Android-Emulation) | 170 bestanden, 2 übersprungen |
| Gesamttest API + PostgreSQL + Browser | 44/44 |
| iPhone-Emulation (WebKit, nur in der CI) | der zuletzt hängende Test lief nach der Korrektur 3× grün |

Nicht getestet: echte iPhones/Android-Geräte, Windows-PC mit echtem Browser, Betrieb auf dem netcup-Server,
Wiederherstellung eines echten Archivs aus der Hetzner Storage Box. Zwei Tests waren unter hoher Rechnerlast je einmal
wackelig und bei Wiederholung stabil (`backup-restore.test.ts`, Arbeitszeitkonto auf Android).

## 3. Offen vor dem Verkauf

### Entscheidungen des Auftraggebers
1. ~~Pausenschwelle~~ – entschieden 28.10.2026, umgesetzt.
2. ~~Korrektur nach Freigabe~~ – entschieden 28.10.2026 (Wiederöffnung mit Begründung), umgesetzt (0017).
3. ~~Gesperrte Firmen~~ – ab Folgemonat 0 €, umgesetzt (0018).
4. USt-Satz 19 % bestätigen und Absenderangaben (§ 14 UStG) im Super-Admin eintragen; bis dahin tragen Rechnungen das
   Wasserzeichen „Entwurf – Pflichtangaben fehlen“. Zahlungsdienstleister auswählen (Kosten, Vertrag).
5. Produktname „Stundenwerk“: Markenprüfung offen.

### Rechtliches (extern prüfen lassen)
6. Entwürfe AGB, AV-Vertrag, Datenschutzerklärung, Impressum, TOM, Löschkonzept u. a. in `/mnt/project-files/recht/`
   (anwaltlich prüfen, Platzhalter ausfüllen).
7. Aufbewahrungs- und Löschfristen, arbeitsrechtliche Prüfung der Pausenberechnung.

### Betrieb
8. Diese Entwicklungsumgebung erreicht den netcup-Server nicht. Die Testversion muss einmal auf dem Server gestartet werden:
   `deploy/update-test.sh release/1.0 --seed-test-env` (Anleitung `deploy/README.md`). Zugangsdaten erscheinen nur in der
   Server-Konsole.
9. Wiederherstellungstest mit einem echten Archiv aus der Storage Box (`deploy/restore-test.sh --docker`).
10. Test auf echten Geräten (iPhone Safari/Home-Bildschirm, Android Chrome, Windows Edge/Chrome), Checkliste `docs/testplan.md`.
11. Produktive Subdomain und Forgejo-Umstellung erst nach Freigabe.

### Kleinere technische Punkte (aus der Schlussprüfung, nicht kritisch)
12. Datums-/Monatsauswahl sind Browser-Felder; Firefox/Safari am Desktop zeigen beim Monat „2026-10“ statt eines Auswahlfelds.
13. Kleine Tabellen-Überstände (3–9 px) an drei Stellen; Standardzeiten im Erfassungsformular prüfen; Länge der USt-IdNr.
    in API (15) und Datenbank (13) angleichen; Tabelle „Vergangene Monate“ zeigt auch den laufenden Monat.
14. Automatisches Aufräumen abgelaufener Sitzungen/Einmal-Links; Frist für das Audit-Log; Lesezugriffe des Supports
    protokollieren; Anmelde-Limits bei mehreren Instanzen zentral speichern.
15. UWE-Logo wirkt in sehr kleiner Darstellung unscharf („KRANKENTRANSPORTF“) – Originaldatei bleibt unverändert,
    ggf. eine kleinere Variante vom Grafiker anfordern.

## 4. Bestehende UWE-App
Die bisherige App auf GitHub Pages läuft unverändert weiter. PR #2 (Version 28, Speicherschutz) wartet auf Freigabe.
