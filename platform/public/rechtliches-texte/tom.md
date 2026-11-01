# Technische und organisatorische Maßnahmen (TOM) nach Art. 32 DSGVO

> **ENTWURF – nicht anwaltlich geprüft, nicht durch externe Sicherheitsprüfung bestätigt.** KI-gestützter Entwurf vom
> 29.10.2026. Die technischen Angaben beruhen auf dem Quellcode und der Dokumentation von Branch `release/1.0`
> (`docs/security.md`, `docs/betrieb.md`, `deploy/`) – sie beschreiben, was die Software leistet, **nicht** den
> geprüften Ist-Zustand des Produktivservers. Punkte mit `[OFFEN]` oder „**nicht umgesetzt**“ sind vor Verwendung als
> AVV-Anlage zu klären. Organisatorische Maßnahmen muss der Anbieter selbst bestätigen.

Stand: Entwurf 0.9.1 vom 29.10.2026 (nach KI-Prüfung überarbeitet) · Gilt als Anlage 1 zum AVV.

Legende Status: ✅ in der Software umgesetzt und durch automatisierte Tests belegt · 🟡 vorgesehen/teilweise ·
❌ nicht umgesetzt · `[OFFEN]` vom Anbieter zu bestätigen

## 1. Vertraulichkeit (Art. 32 Abs. 1 lit. b DSGVO)

### 1.1 Zutrittskontrolle (Rechenzentrum)

| Maßnahme | Status |
|---|---|
| Server bei netcup GmbH, Backups bei Hetzner Online GmbH in Rechenzentren in Deutschland/EU; physische Sicherheit (Zutrittskontrolle, Videoüberwachung, Brandschutz) nach den TOM der Rechenzentrumsbetreiber | `[OFFEN: TOM/Zertifikate (z. B. ISO/IEC 27001) beider Anbieter beifügen]` |
| Kein eigener Serverraum; Zugang zu Arbeitsplätzen des Anbieters: `[OFFEN: Büro abschließbar, Bildschirmsperre]` | `[OFFEN]` |

### 1.2 Zugangskontrolle (Systeme)

| Maßnahme | Status |
|---|---|
| Passwörter nur als scrypt-Hash (N = 32768) gespeichert | ✅ |
| Zwei-Faktor-Anmeldung (TOTP, RFC 6238) – **Pflicht für alle Plattformkonten** (Super-Admin, Support), für Leitungskräfte je Kunde einschaltbar, für alle anderen freiwillig; Geheimnisse AES-256-GCM-verschlüsselt, Schlüssel getrennt von der Datenbank | ✅ |
| Sitzungs-Cookie `__Host-sid`: `HttpOnly`, `Secure`, `SameSite=Strict`; absolute Laufzeit und Leerlauf-Abmeldung (Standard 120 Minuten) | ✅ |
| Begrenzung von Fehlversuchen je IP, je IP+E-Mail und je E-Mail-Adresse; Begrenzung von 2FA-Versuchen; keine Kontenaufzählung | ✅ (🟡 Zähler nur je Server-Instanz) |
| Einladungs- und Passwort-Links: Einmal-Token, nur als SHA-256-Hash gespeichert, 7 Tage bzw. 1 Stunde gültig; nie Passwortversand | ✅ |
| Serverzugang (SSH) nur mit Schlüssel, kein Passwort-Login, Root-Login deaktiviert | `[OFFEN: am netcup-Server bestätigen]` |
| PostgreSQL nur im internen Docker-Netz erreichbar, `scram-sha-256` | 🟡 (laut `deploy/docker-compose.yml` vorgesehen; Server nicht geprüft) |
| Geheimnisse (DB-Passwörter, Schlüssel) nur in Umgebungsdatei mit Rechten 600 bzw. Passwort-Manager, nie im Repository; automatischer Secret-Scan (gitleaks) | ✅ Repository / `[OFFEN]` Server |

### 1.3 Zugriffskontrolle (Berechtigungen)

| Maßnahme | Status |
|---|---|
| **Mandantentrennung in der Datenbank** durch Row Level Security auf allen Tabellen; die API-Rolle kann RLS nicht umgehen; automatisierter Test prüft jede Tabelle und **jede API-Route** mit fremden Konten | ✅ |
| Rollenmodell Mitarbeiter/in – Vorgesetzte – Inhaber/in; Schutz gegen Rechteausweitung durch Datenbank-Trigger (keine Änderung der eigenen Rolle/des eigenen Status) | ✅ |
| Plattformpersonal sieht **über die Anwendung** ohne Freigabe keine personenbezogenen Daten, nur Metadaten und Zahlen (Wartungszugang siehe Ziff. 5) | ✅ |
| Support-Freigabe durch Inhaber/in: befristet (1–168 h), widerrufbar, nur lesend, Erteilen/Widerrufen protokolliert | ✅ |
| Protokollierung **einzelner Lesezugriffe** des Supports | ❌ nicht umgesetzt |
| Gesperrte Mitarbeitende und gesperrte Mandanten verlieren den Zugang sofort, auch laufende Sitzungen | ✅ |

### 1.4 Trennungskontrolle

| Maßnahme | Status |
|---|---|
| Logische Trennung aller Kunden über `tenant_id` + RLS (siehe 1.3) | ✅ |
| Trennung von **anderen Anwendungen auf demselben Server** (zentraler Caddy im Netz `proxy`, zentrales Backup, weitere appzentrale24-Dienste): eigene Container, eigenes Datenbank-Netz und Volume; Zugriffsrechte der Administratoren anderer Anwendungen | `[OFFEN: Liste der Anwendungen und Admin-Rechte]` |
| Getrennte Test- und Produktivumgebung (eigene Container, Datenbank, Subdomain); Testdaten ausschließlich erfunden, Befehl zum Befüllen der Testumgebung verweigert bei echten Mandanten | ✅ Software / `[OFFEN]` Server |
| Entwicklung und CI nur mit erfundenen Daten | ✅ |

### 1.5 Pseudonymisierung/Verschlüsselung (Art. 32 Abs. 1 lit. a DSGVO)

| Maßnahme | Status |
|---|---|
| Transportverschlüsselung TLS (HTTPS) über den Reverse Proxy (Caddy), HSTS in Produktion | ✅ Software / `[OFFEN]` Zertifikat am Server prüfen |
| Datensicherungen GPG-verschlüsselt (empfohlen: öffentlicher Schlüssel auf dem Server, privater Schlüssel offline beim Anbieter) mit SHA-256-Prüfsumme | ✅ Skript / `[OFFEN: Schlüsselverwahrung bestätigen]` |
| Verschlüsselung der Datenträger des Servers (Festplattenverschlüsselung) | `[OFFEN: bei netcup-VPS üblicherweise nicht – bewusste Entscheidung dokumentieren]` |
| Anonymisierung ausgeschiedener Mitarbeitender nach Fristablauf durch den Kunden | ✅ |

## 2. Integrität (Art. 32 Abs. 1 lit. b DSGVO)

| Maßnahme | Status |
|---|---|
| Arbeitszeiten werden nie physisch gelöscht (Soft-Delete); jede Änderung erzeugt eine Revision | ✅ |
| Änderungsprotokoll (Audit-Log) nur anhängend; Ändern/Löschen auch für Datenbank-Administratoren per Trigger gesperrt (einzige Ausnahme: Anonymisierung nach Fristablauf) | ✅ |
| Freigegebene Monate gesperrt; Korrektur nur nach protokollierter Wiederöffnung mit Begründung und erneuter Freigabe | ✅ seit Migration 0017 in der Datenbank erzwungen; Verlauf in `monthly_statement_events` (DB/Server-Tests laut Technik-Thread 392/392 grün, Stand Software: `release/1.0` @ `ded4eb1` (29.10.2026)) |
| Optimistische Sperre gegen stilles Überschreiben bei gleichzeitiger Bearbeitung; idempotente Offline-Synchronisierung | ✅ |
| Schutz gegen Web-Angriffe: CSRF-Schutz (SameSite + Origin-Prüfung), Content-Security-Policy, `X-Frame-Options: DENY`, `nosniff`; Logo-Uploads nur PNG/JPEG/WebP mit Signaturprüfung (keine SVG) | ✅ |
| Statische Codeanalyse (CodeQL), Abhängigkeitsprüfung (Dependabot), Linting und Tests in der CI | ✅ |

## 3. Verfügbarkeit und Belastbarkeit (Art. 32 Abs. 1 lit. b, c DSGVO)

| Maßnahme | Status |
|---|---|
| Tägliches verschlüsseltes Datenbank-Backup (`deploy/backup.sh`), lokal 14 Sätze, Übergabe an restic-Repository auf der Hetzner Storage Box | ✅ Skript / `[OFFEN: Cronjob am Server, restic-Aufbewahrungsregel (forget/prune) bestätigen]` |
| Wiederherstellungsprobe in eine leere Datenbank, automatisiert in der CI; monatlich am Server vorgesehen | ✅ CI / ❌ **mit echtem Archiv aus der Storage Box noch nicht durchgeführt** (Abnahmebericht 28.10.2026) |
| Zwei-Faktor-Schlüssel getrennt von Backups gesichert | `[OFFEN]` |
| Offline-Erfassung in der Mitarbeiter-App überbrückt Serverausfälle | ✅ |
| Zentrales Server-Backup (`pg_dumpall`, bestehendes System) enthält ebenfalls die Datenbank | `[OFFEN: Speicherort, Verschlüsselung, Aufbewahrung]` |
| Löschung eines echten Mandanten nach Vertragsende: `cli.ts delete-tenant` (nur deaktivierte Mandanten), löscht Personen-, Zeit- und Audit-Daten; Rechnungen/abgeschlossene Abrechnungsmonate bleiben unter anonymisiertem Platzhalter | ✅ Software / `[OFFEN: am Produktivserver noch nicht angewendet]` |
| Gesamtexport durch den Betreiber für Mandanten in jedem Status (`cli.ts export-tenant`, protokolliert, mit Prüfsummen) | ✅ |
| Monitoring der Erreichbarkeit, Anzeige „letzte Sicherung“ in der Systemübersicht | 🟡 (Statusdatei noch nicht in den Container eingebunden) |
| Einzelner Server, keine Hochverfügbarkeit; Wiederanlaufziel ein Werktag (Anlage B) | bewusst |
| Notfallplan / Wiederanlaufhandbuch | 🟡 `docs/betrieb.md` Abschnitt 5 / `[OFFEN: freigeben]` |

## 4. Verfahren zur regelmäßigen Überprüfung (Art. 32 Abs. 1 lit. d DSGVO)

| Maßnahme | Status |
|---|---|
| Automatisierte Tests bei jeder Änderung (Unit, Datenbank inkl. Mandantentrennung, Browser) | ✅ |
| Monatliche Wiederherstellungsprobe, dokumentiert | `[OFFEN]` |
| Jährliche Überprüfung dieser TOM, Datum und Ergebnis dokumentiert | `[OFFEN]` |
| Datenschutz-Management: Benennung eines Datenschutzbeauftragten, falls erforderlich (§ 38 BDSG: in der Regel mind. 20 Personen ständig mit automatisierter Verarbeitung) | `[OFFEN]` |

## 5. Organisatorische Maßnahmen

| Maßnahme | Status |
|---|---|
| Verpflichtung aller Personen mit Zugriff auf Vertraulichkeit (Art. 28 Abs. 3 lit. b, Art. 29 DSGVO) | `[OFFEN]` |
| Datenschutz- und Sicherheitsschulung bei Einstellung und jährlich | `[OFFEN]` |
| Berechtigungskonzept für Plattformkonten (wer ist Super-Admin/Support), Entzug bei Ausscheiden | `[OFFEN]` |
| Vorgehen bei Datenschutzverletzungen (Erkennen, Bewerten, Melden binnen 24 h an Kunden, Dokumentation); Erreichbarkeit/Rufbereitschaft auch außerhalb der Supportzeiten | `[OFFEN: Prozess schriftlich festlegen]` |
| **Wartungszugriffe** mit Datenbank-Eigentümerrechten (2FA-Rücksetzung, Adressänderung, Wiederherstellung, Mandantenlöschung): Personenkreis, Anlass, Ticket/Protokoll, Information des Kunden | `[OFFEN]` – ❌ keine automatische Protokollierung |
| Auswahl von Dienstleistern nur mit Verarbeitung in der EU/im EWR (E-Mail, Postfach, Buchhaltung) | `[OFFEN: als Vorgabe beschließen]`; E-Mail-Versand: Brevo (Frankreich, EU), Übertragung zum SMTP-Relay verschlüsselt (STARTTLS, Port 2525), Absenderdomain mit DKIM und DMARC, Öffnungs-/Klickverfolgung aus `[OFFEN: prüfen]`, Speicherung der Mail-Inhalte bei Brevo möglichst abschalten (Einmal-Links; diese sind einmal verwendbar und befristet), SMTP-Schlüssel nur in der Umgebungsdatei des Servers (Rechte 600) |
| AV-Verträge mit netcup und Hetzner abgeschlossen | `[OFFEN: Nachweis]` |
| Änderungen am Produktivsystem nur nach Freigabe; Code-Review vor Zusammenführung | ✅ Repository (CODEOWNERS, Draft-PR) |

## 6. Datenschutz durch Technikgestaltung (Art. 25 DSGVO)

- Datensparsamkeit: keine Standort-, Gesundheits- oder Gerätedaten; keine IP-Adressen in der Datenbank;
  Bemerkungen auf 500 Zeichen begrenzt, mit Hinweis „keine Patientendaten eintragen“.
- Datenschutzfreundliche Voreinstellungen: Support sieht ohne Freigabe nichts; 2FA für Plattformkonten Pflicht.
- Selbstbedienung für Auskunft, Export und Anonymisierung.
- Keine Tracking- oder Analysedienste, keine Werbe-Cookies `[OFFEN: für Website bestätigen]`.

---

**Offene Punkte dieses Dokuments:** alle `[OFFEN]`-Zeilen; insbesondere Wiederherstellungstest mit echtem
Storage-Box-Archiv, Backup-Aufbewahrungsdauer (restic), Server-Härtung (SSH), organisatorische Maßnahmen,
Protokollierung von Support-Lesezugriffen.
