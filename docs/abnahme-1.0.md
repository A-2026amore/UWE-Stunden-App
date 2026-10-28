# Abnahmebericht Stunden-App 1.0 (Stand 28.10.2026)

Branch `release/1.0`, Draft-PR #7 (nicht mergen). Alle Daten in Tests und Screenshots sind erfunden.

## 1. Was funktioniert

| Bereich | Stand |
|---|---|
| Mitarbeiter-App (PWA) | Anmeldung (Passwort, optional 2FA), mehrere Einsätze pro Tag, Pausenprüfung ohne Vorbelegung, automatische Summen, Tages-/Monatsansicht, Korrekturanfragen, PDF-Stundenzettel (mehrseitig), Firmenlogo/-name, Offline-Erfassung mit Synchronisierung, Installationshinweis für iPhone/Android, Datenauskunft |
| Chef-Portal | Mitarbeiter anlegen, einladen („Zugang senden“ per E-Mail/WhatsApp-Einmal-Link), sperren, deaktivieren; Stundenübersicht je Mitarbeiter und Monat; Freigabe/Rückgabe von Monatsnachweisen; Korrekturen mit Verlauf; PDF- und CSV-Export; Firmenprofil mit Logo, Anschrift, E-Mail, Telefon, WhatsApp; Pausenregel; Abrechnung; Datenschutz; Handy-Menü |
| Mehrmandanten | Trennung in PostgreSQL (Row Level Security); automatischer Test ruft **jede** API-Route mit fremden Konten auf |
| Super-Admin | Firmen anlegen (auch kostenlose Testkunden), freischalten, sperren, deaktivieren; Mitarbeiterzahlen, Umsatz je Monat, Abrechnungsstatus, Sonderkonditionen, Standardpreis; Systemübersicht; Protokoll aller Admin-Aktionen; personenbezogene Daten nur mit befristeter Freigabe der Firma |
| Preismodell | 5,00 € netto je abrechenbarem Mitarbeiter/Monat; Leitung ohne eigene Zeiten kostenlos; Gesperrte/Deaktivierte ab Folgemonat frei; Gratis-Konten; Festschreibung abgeschlossener Monate; Zahlungsdienst nur vorbereitet |
| Sicherheit | scrypt-Passwörter, sichere Sitzungs-Cookies, CSRF-/Herkunftsprüfung, CSP, Anmelde-Limits je IP und je E-Mail, 2FA (Pflicht für Plattformkonten), Audit-Log |
| Backups | verschlüsseltes Datenbank-Backup mit Prüfsumme, Wiederherstellungsprobe in eine leere Datenbank (läuft in der CI) |

## 2. Tests

Siehe CI von PR #7. Lokal zuletzt grün: Unit, Datenbank/Server (inkl. Mandantentrennung), Browsertests Demo und Gesamttest
(API + PostgreSQL + Browser) auf Desktop-Chromium und Android-Emulation. iPhone (WebKit) läuft nur in der CI.
Nicht getestet: echte iPhones/Android-Geräte, Betrieb auf dem netcup-Server, Wiederherstellung eines echten Archivs aus der
Hetzner Storage Box.

## 3. Offen vor dem Verkauf

### Entscheidungen des Auftraggebers
1. ~~Pausenschwelle~~ – entschieden 28.10.2026: neue Firmen gesetzlich (mehr als 6/9 h), UWE streng (ab genau 6/9 h). Umgesetzt.
2. Korrektur nach Freigabe (N1): freigegebenen Monat neu berechnen, nur kennzeichnen (heute) oder sperren.
3. Gesperrte/deaktivierte Firmen: weiter berechnen (heute) oder automatisch kostenfrei.
4. Rechnungen: Nummernkreis, Rechnungs-PDF, Versand; Auswahl eines Zahlungsdienstleisters (Kosten, Vertrag).
5. Produktname (heute „Stundenwerk (Arbeitstitel)“).

### Rechtliches (extern prüfen lassen)
6. AGB, Auftragsverarbeitungsvertrag, Datenschutzerklärung, Impressum; Entwürfe/Hinweise in `docs/datenschutz.md`.
7. Aufbewahrungs- und Löschfristen (in der App einstellbar, Standard „keine automatische Frist“).
8. Arbeitsrechtliche Prüfung der Pausenberechnung (Schwellen gelten für die Einsatzzeit des Tages).

### Betrieb
9. Zugriff dieser Entwicklungsumgebung auf `appzentrale24.de` (Cloud-Umgebung mit erlaubter Domain, ggf. SSH-Schlüssel als Geheimnis).
10. Neue Version in die Testumgebung `stunden-test.appzentrale24.de` bringen und Testzugänge anlegen (`deploy/README.md`).
11. Wiederherstellungstest mit einem echten Archiv aus der Hetzner Storage Box (`deploy/restore-test.sh --docker`).
12. Test auf echten Geräten (iPhone Safari/Home-Bildschirm, Android Chrome), Checkliste `docs/testplan.md`.
13. Produktive Subdomain (Vorschlag `stunden.appzentrale24.de`) erst nach Freigabe; Forgejo-Umstellung erst nach Freigabe.

### Kleinere technische Punkte
14. Automatisches Aufräumen abgelaufener Sitzungen/Einmal-Links; Frist für das Audit-Log.
15. Einzelne Lesezugriffe des Supports protokollieren.
16. Anmelde-Limits gelten je Server-Instanz (bei mehreren Instanzen zentral speichern).
17. Statusdatei „letzte Sicherung“ in den App-Container einbinden.

## 4. Bestehende UWE-App
Die bisherige App auf GitHub Pages läuft unverändert weiter. PR #2 (Version 28, Speicherschutz) wartet auf Freigabe.
Bisherige Stunden müssen laut Auftraggeber nicht übernommen werden; ein Import ist trotzdem vorhanden.
