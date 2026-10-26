# Ist-Analyse UWE Stunden-App (Stand: Version 27, Commit 46eff48, 26.10.2026)

Diese Analyse beschreibt den tatsächlichen Stand des Repositorys `A-2026amore/UWE-Stunden-App`
(Branch `main`) vor Beginn der Plattform-Entwicklung. Sie ist die Grundlage für Architektur,
Migration und Testplanung.

## 1. Überblick

| Bereich | Datei(en) | Zweck |
|---|---|---|
| Mitarbeiter-App (produktiv) | `index.html` (Markup, CSS und ca. 650 Zeilen Inline-JavaScript) | Anmeldung, Zeiterfassung, Monatsübersicht, Arbeitszeitkonto, PDF/CSV, Backup |
| Test-Mitarbeiter | `test-mitarbeiter.html` | Kopie von `index.html` (ca. 95 % identisch) ohne Anmeldung, eigener Speicherschlüssel |
| Chef-Verwaltung | `chef-mobil.html`, `chef-mobil.js`, `chef-staff.js` | Einladungen signieren, Mitarbeiterliste (verschlüsselt lokal), Sperrwünsche vormerken |
| Pausenregeln | `uwe-break-rules.js` | 6 h → 30 min, 9 h → 45 min (jeweils inklusive), max. 12 h, Überschneidungen |
| Arbeitszeitkonto | `uwe-arbeitszeitkonto.js` | NRW-Schuljahreskonto, –100 h je Schuljahr, Monatsübertragungen |
| PDF | `uwe-pdf.js` | Eigener PDF-Generator (A4, mehrseitig, Vektor-Logo), ohne Fremdbibliothek |
| Zugangsprüfung | `uwe-access-check.js`, `uwe-access-control.json` | Öffentliche Sperrliste, wird online geprüft |
| Konfiguration | `uwe-config.js` | Öffentlicher ECDSA-Schlüssel (P-256) zur Prüfung der Einladungen |
| PWA | `sw.js`, `manifest.json`, `chef-manifest.json`, `chef-pwa.json`, Icons | Installierbare Web-App, Offline-Cache |
| Branding | `uwe-logo.svg`, `uwe-fluegel.svg`, `icon*.png`, `apple-touch-icon.png` | Original-UWE-Logo (darf nicht verändert werden) |

Technik: reines HTML/CSS/JavaScript ohne Build-Schritt, Auslieferung über GitHub Pages direkt aus
`main`. Keine Abhängigkeiten, keine Tests, keine CI. 151 Commits seit 23.10.2026, jeder Commit
erscheint doppelt (Upload-Muster des bisherigen Werkzeugs).

## 2. Funktionsweise heute

**Anmeldung.** Der Chef erzeugt in der Chef-Verwaltung pro Mitarbeiter einen Zugangscode:
`base64url(JSON{v,eid,name,exp,salt,pinHash}) + "." + ECDSA-Signatur`. Der private Schlüssel liegt
passwortverschlüsselt (PBKDF2 250.000 / AES-GCM) in einer JSON-Sicherungsdatei und optional im
`localStorage` des Chef-Geräts. Der Mitarbeiter öffnet den Link (per WhatsApp verschickt) und gibt
seine PIN ein; die App prüft Signatur, Ablaufdatum und PIN-Hash (PBKDF2 100.000) lokal.

**Sperren.** Gesperrte Personalnummern stehen in der öffentlichen Datei `uwe-access-control.json`.
Die App prüft sie vor jeder Speicherung online (45 s Cache). Die Chef-Verwaltung kann Sperren nur
*vormerken* und einen Textauftrag kopieren, den bisher ein KI-Chat ins Repository geschrieben hat.

**Daten.** Alle Arbeitszeiten liegen ausschließlich im `localStorage` des Mitarbeiter-Handys
(`uwe_hours_2_<Personalnummer>`), das Arbeitszeitkonto unter `uwe_arbeitszeitkonto_v1_<Personalnummer>`.
Es gibt keinen zentralen Datenbestand. Der Monatsnachweis wird als PDF per WhatsApp/E-Mail an UWE
geschickt. Backups sind JSON-Dateien (Formate v2–v4), die der Mitarbeiter selbst herunterlädt.

**Fachlogik.** Mehrere Einsätze pro Tag, Schichten über Mitternacht (Ende ≤ Beginn), Pausenvorschlag,
Überschneidungsprüfung, Tages- und Monatssummen, Arbeitszeitkonto mit Monatsaufteilung
(Beispiel 50 h geleistet, 20 h ins Konto, 30 h zur Abrechnung), NRW-Sommerferien 2026–2030 fest
hinterlegt, spätere Jahre optional über openholidaysapi.org.

## 3. Stärken (bleiben erhalten)

- Fachlogik ist sorgfältig und defensiv geschrieben (Validierung, keine stillen Änderungen).
- Mehrseitiges, gut lesbares PDF ohne Fremdbibliothek; Teilen über Web Share API.
- Kryptografisch signierte Einladungen, PIN wird nicht im Klartext gespeichert.
- Klare deutsche Texte, Hinweise zur Unverbindlichkeit des Test-Arbeitszeitkontos.

## 4. Schwachstellen und Risiken

Bewertung: **hoch** = vor Verkauf/Ausbau zwingend lösen, **mittel** = mit der neuen Architektur lösen,
**niedrig** = bei Gelegenheit.

| # | Befund | Risiko |
|---|---|---|
| R1 | Kein zentraler Datenbestand: Handyverlust, App-Löschung oder Safari-Speicherbereinigung (iOS löscht Website-Daten nach längerer Nichtnutzung) können Arbeitszeiten vernichten, wenn kein Backup existiert. | hoch |
| R2 | Daten sind vom Mitarbeiter frei änderbar, das PDF ist selbst erstellt. Der Arbeitgeber kann Echtheit und Vollständigkeit nicht prüfen; es gibt kein Änderungsprotokoll. | hoch |
| R3 | **Öffentliches Repository mit Personenbezug:** `chef-mobil.html` enthält vorbefüllte Vornamen mit Personalnummern; `uwe-access-control.json` (Sperrliste) ist öffentlich. Personaldaten gehören nicht in ein öffentliches Repository. Hinweis: GitHub Pages aus einem privaten Repository erfordert einen kostenpflichtigen GitHub-Tarif. | hoch (Entscheidung Auftraggeber) |
| R4 | Der Einladungslink enthält Salt und PIN-Hash. Wer einen Link abfängt (z. B. weitergeleitete WhatsApp-Nachricht), kann eine 6-stellige PIN offline durchprobieren (10⁶ Versuche × PBKDF2 100.000 ist mit Grafikkarte machbar). Die automatisch erzeugten 9-stelligen PINs sind deutlich robuster. | mittel |
| R5 | Sperren wirken nur über eine Datei im Repository und einen manuellen KI-Chat-Auftrag; kein Rollen-/Rechtemodell, keine Protokollierung. | hoch für SaaS |
| R6 | Offline-Erfassung ist faktisch nicht möglich: vor jeder Speicherung ist eine Online-Zugangsprüfung nötig. | mittel |
| R7 | Überschneidungsprüfung nur innerhalb desselben Datums: eine Nachtschicht 22:00–06:00 und ein Einsatz am Folgetag um 05:00 werden nicht als Überschneidung erkannt. Die 12-Stunden-Summe wird je Startdatum gebildet. | mittel (fachlich zu klären, nicht eigenmächtig geändert) |
| R8 | UWE-Branding, WhatsApp-Nummer, Repository-Adresse und Schuljahresregel sind fest im Code – nicht mandantenfähig. | hoch für SaaS |
| R9 | `index.html` und `test-mitarbeiter.html` sind Kopien; jede Änderung muss doppelt gepflegt werden. Inline-Skripte erschweren eine Content-Security-Policy. | mittel |
| R10 | Keine automatisierten Tests, keine CI, keine Versions-/Release-Strategie; Cache-Versionen im Service Worker werden von Hand hochgezählt. | mittel |
| R11 | Service Worker cacht jede erfolgreiche Antwort derselben Herkunft; bei Fehlern kann eine veraltete Version ausgeliefert werden. Updates greifen erst nach erneutem Öffnen. | niedrig |
| R12 | Rechtliche Punkte (Pausenregel strenger als ArbZG bei „genau 6/9 Stunden“, Minussaldo –100 h, Schuljahreskonto) sind betriebliche Regeln. Sie sind korrekt als „Test/unverbindlich“ gekennzeichnet; eine arbeitsrechtliche Prüfung steht aus. | Entscheidung Auftraggeber |

## 5. Was für die Migration geschützt werden muss

Siehe `docs/legacy-storage.md` (vollständiges Speicherinventar) und `docs/migrationsplan.md`.
Kernpunkte: Alle `uwe_hours_2_*`- und `uwe_arbeitszeitkonto_v1_*`-Daten, bestehende Einladungslinks
und PINs müssen weiter funktionieren, bis jeder Mitarbeiter migriert ist. Die bestehende App wird
nicht abgeschaltet; die neue Plattform läuft getrennt, bis der Auftraggeber die Umstellung freigibt.

## 6. Folgerungen für die Architektur

1. Zentrale PostgreSQL-Datenbank mit Mandantentrennung per Row Level Security (siehe `docs/architektur.md`).
2. Fachlogik aus den bestehenden Modulen wird 1:1 übernommen und per Vergleichstests gegen den
   Altcode abgesichert (kein Neuschreiben der Regeln).
3. Offline-first Mitarbeiter-App: lokale Erfassung, Synchronisierung mit eindeutigen Eintrags-IDs
   (keine Duplikate), Versionsnummern zur Konflikterkennung.
4. Mandantenkonfiguration statt fest eingebauter UWE-Regeln.
5. Neue Plattform in `platform/`, getrennt von den Produktivdateien im Repository-Stamm.
