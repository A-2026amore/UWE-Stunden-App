# Datenschutz (DSGVO) – Entwurf

> **Entwurf – rechtlich prüfen lassen.** Dieses Dokument beschreibt, was die Software technisch leistet, und
> enthält Vorlagen für das Verzeichnis von Verarbeitungstätigkeiten (VVT), die technischen und organisatorischen
> Maßnahmen (TOMs) und den Auftragsverarbeitungsvertrag (AV-Vertrag). Es ist **keine Rechtsberatung**. Fristen,
> Rechtsgrundlagen und Vertragstexte legt der Auftraggeber mit Datenschutzbeauftragtem bzw. Rechtsberatung fest.

Stand: 28.10.2026, Migration `0016_privacy.sql`. Technische Details: [`security.md`](security.md),
API: [`api.md`](api.md), Datenbank: [`database.md`](database.md), Betrieb und Backups: [`betrieb.md`](betrieb.md).

## 1. Rollen

| Wer | Rolle nach DSGVO (Annahme, zu prüfen) |
|---|---|
| Kundenfirma (Mandant, z. B. ein Krankentransport- oder Pflegedienst) | **Verantwortlicher** für die Arbeitszeitdaten ihrer Beschäftigten |
| Plattformbetreiber (Stundenwerk / appzentrale24) | **Auftragsverarbeiter** der Kundenfirmen; Verantwortlicher nur für eigene Vertrags- und Abrechnungsdaten |
| Rechenzentrum/Server (netcup), Backup-Speicher (Hetzner Storage Box), ggf. E-Mail-Versand (SMTP-Anbieter) | **Unterauftragsverarbeiter** des Betreibers |
| UWE – Krankentransporte GmbH bei Eigennutzung | Verantwortlicher; Betreiber und Kunde sind dann dieselbe Stelle oder eng verbunden (zu klären) |

## 2. Verzeichnis von Verarbeitungstätigkeiten (Entwurf je Kundenfirma)

| Feld | Inhalt (Vorschlag) |
|---|---|
| Bezeichnung | Elektronische Arbeitszeiterfassung und Arbeitszeitkonto |
| Zweck | Erfassung und Nachweis der Arbeitszeit (u. a. § 16 Abs. 2 ArbZG), Lohnabrechnung, Arbeitszeitkonto, Monatsnachweise, Korrekturen |
| Rechtsgrundlage | Art. 6 Abs. 1 lit. b und c DSGVO, § 26 BDSG bzw. Nachfolgeregelung – **zu prüfen** |
| Betroffene | Beschäftigte der Kundenfirma (Mitarbeitende, Leitung, Inhaber) |
| Datenkategorien | Name, Personalnummer, dienstliche E-Mail, Rolle, Status (aktiv/deaktiviert), Arbeitszeiten (Datum, Beginn, Ende, Pause, Bemerkung), Änderungsverlauf, Monatsnachweise, Arbeitszeitkonto, Korrekturanfragen mit Begründung, Anmeldesitzungen (Zeitpunkte, Browser-Kennung; keine IP-Adressen in der Datenbank), Zwei-Faktor-Status, Änderungsprotokoll |
| Keine Daten zu | Gesundheit, Standort, Patienten. Die App weist darauf hin, keine Patientendaten in Bemerkungen einzutragen. |
| Empfänger | Leitung und Inhaber der Kundenfirma; Plattform-Support nur mit befristeter Freigabe des Inhabers; Unterauftragsverarbeiter (Hosting, Backup, E-Mail) |
| Drittland | keines vorgesehen (Server und Backups in Deutschland/EU) – bei Wahl eines E-Mail-Anbieters prüfen |
| Löschfristen | siehe Abschnitt 5 – **vom Verantwortlichen festzulegen** |
| TOMs | siehe Abschnitt 3 |

## 3. Technische und organisatorische Maßnahmen (Stand der Software)

| Ziel | Maßnahme | Beleg |
|---|---|---|
| Vertraulichkeit – Mandantentrennung | Row-Level-Security in PostgreSQL für jede Tabelle; die API prüft zusätzlich jede Route; automatischer Test ruft **alle** Routen mit fremden Rollen auf | `tests/db/*`, `tests/server/route-isolation.test.ts` |
| Vertraulichkeit – Zugriff des Betreibers | Plattformpersonal sieht personenbezogene Daten nur mit befristeter, widerrufbarer Freigabe des Inhabers; Erteilen und Widerrufen werden protokolliert | `security.md` Abschnitt 3, `tests/server/platform-audit-visibility.test.ts` |
| Zugangskontrolle | Passwörter nur als scrypt-Hash; Sitzungs-Cookie `HttpOnly`, `Secure`, `SameSite=Strict`; Leerlauf-Abmeldung; Begrenzung von Fehlversuchen (je IP und je Konto); Zwei-Faktor-Anmeldung (Pflicht für Plattformkonten, für Leitungen je Firma einschaltbar) | `security.md` Abschnitte 4, 4a |
| Integrität | Arbeitszeiten werden nie gelöscht (Soft-Delete), jede Änderung als Revision; Änderungsprotokoll ist append-only; freigegebene Monate gesperrt | `security.md` Abschnitt 5 |
| Verfügbarkeit | tägliche verschlüsselte Sicherung (`deploy/backup.sh`), Übergabe an das Offsite-Backup, regelmäßige Wiederherstellungsprobe (`deploy/restore-test.sh`), in der CI automatisch geprüft | `betrieb.md` Abschnitt 5 |
| Transportverschlüsselung | HTTPS über den zentralen Reverse Proxy, HSTS | `deploy/README.md` |
| Datensparsamkeit | nur die oben genannten Felder; Bemerkung max. 500 Zeichen; keine Standort- oder Gerätedaten | – |
| Trennung Test/Produktion | eigene Testumgebung mit ausschließlich erfundenen Testfirmen (`cli.ts seed-test-env`, verweigert bei echten Mandanten) | `deploy/README.md` |

Organisatorische Maßnahmen (Zutrittskontrolle Rechenzentrum, Schulung, Vertraulichkeitsverpflichtung, Notfallplan)
sind vom Betreiber zu ergänzen.

## 4. Hinweise zum AV-Vertrag (Betreiber ↔ Kundenfirma)

Zu regeln (Vorschlag, Text durch Rechtsberatung):

- Gegenstand, Dauer, Art und Zweck der Verarbeitung, Datenkategorien, Betroffene (aus Abschnitt 2).
- Weisungsgebundenheit; Support-Zugriff **nur** nach Freigabe in der Software (Einstellungen → Support-Zugriff)
  und nur so lange wie freigegeben.
- Unterauftragsverarbeiter: netcup (Server), Hetzner (Backup-Speicher), ggf. E-Mail-Anbieter – Liste aktuell
  halten, Kunden über Änderungen informieren.
- TOMs nach Abschnitt 3 als Anlage.
- Unterstützung bei Betroffenenrechten: Datenauskunft und Anonymisierung sind in der Software selbst möglich
  (Abschnitt 6).
- Rückgabe und Löschung bei Vertragsende: Gesamtexport durch den Inhaber (Chef-Portal → Datenschutz, solange der
  Mandant aktiv ist) oder durch den Betreiber in jedem Status (`cli.ts export-tenant`), danach Löschung des
  deaktivierten Mandanten durch den Betreiber (`cli.ts delete-tenant`, getestet, `betrieb.md` Abschnitt 6.1b) –
  Frist für die Löschung und für Backups (Backups laufen nach ihrer Aufbewahrungsdauer aus) im Vertrag festlegen.
- Meldung von Datenschutzverletzungen, Kontrollrechte.

## 5. Aufbewahrung und Löschung

**Die Software legt keine Fristen fest.** Die Kundenfirma (Inhaber) stellt im Chef-Portal unter
**Datenschutz → Aufbewahrungsfrist nach dem Austritt** eine Frist in Monaten ein (1–600, leer = keine Frist).
Ohne Frist ist keine Anonymisierung möglich.

Hinweise zur Wahl der Frist (**rechtlich prüfen**): Arbeitszeitnachweise nach § 16 Abs. 2 ArbZG mindestens
zwei Jahre; lohn- und steuerrelevante Unterlagen können längeren Pflichten unterliegen (z. B. HGB/AO, bis zu
zehn Jahre, je nachdem, ob die Daten als Buchungsbeleg dienen). Arbeitsrechtliche Verjährungsfristen beachten.

| Daten | Umsetzung |
|---|---|
| Ausgeschiedene Mitarbeitende | **Anonymisierung** durch den Inhaber nach Ablauf der Frist (gerechnet ab der Deaktivierung), siehe unten |
| Arbeitszeiten | bleiben **ohne Personenbezug** erhalten (Zeiten, Pausen, Dauer); Bemerkungen werden geleert |
| Sitzungen, Einmal-Links, Zwei-Faktor-Daten | bei der Anonymisierung gelöscht; automatische Bereinigung abgelaufener Einträge ist **noch nicht** als Wartungsjob umgesetzt (offen) |
| Gekündigte Kundenfirma | Gesamtexport (JSON/CSV) durch den Inhaber oder Betreiber (`cli.ts export-tenant`); Deaktivierung, dann Löschung durch den Betreiber (`cli.ts delete-tenant`, `betrieb.md` 6.1b); nur Rechnungen/abgerechnete Monate der Plattform bleiben |
| Backups | enthalten die Daten bis zum Ablauf ihrer Aufbewahrung (lokal `BACKUP_KEEP_LOCAL`, offsite nach restic-Regel); keine Einzellöschung in Backups – im Löschkonzept erwähnen |

### Anonymisierung – was genau passiert

Voraussetzungen: Inhaber-Rolle, Person **deaktiviert**, Frist festgelegt und abgelaufen, Bestätigung durch
Eingabe der Personalnummer. Dann (in einer Transaktion, `public.anonymize_employee`):

- Name → „Anonymisiert XXXXXXXX“, Personalnummer → `ANON-…`, E-Mail entfernt; die Person kann nicht mehr
  bearbeitet oder reaktiviert werden.
- Benutzerkonto: wird es von keiner anderen Firma mehr genutzt, werden Adresse, Passwort, Sitzungen,
  Zwei-Faktor-Daten und Einmal-Links entfernt und das Konto gesperrt. Gehört das Konto noch zu einer anderen
  Firma, bleibt es für diese bestehen – nur die Verknüpfung zu dieser Firma wird gelöst.
- Einladungen: Adresse ersetzt, widerrufen.
- Bemerkungen der Arbeitszeiten, Begründungen in Korrekturanfragen und Prüfvermerke werden geleert bzw. durch
  `[anonymisiert]` ersetzt – auch im Änderungsverlauf und im Änderungsprotokoll dieser Firma.
- Arbeitszeiten, Monatsnachweise (Zahlen) und Arbeitszeitkonto bleiben für Auswertungen und Abrechnung
  erhalten.
- Ein Protokolleintrag „Anonymisierung nach Ablauf der Aufbewahrungsfrist“ hält fest, wer wann anonymisiert
  hat (ohne die alten Werte).

Nicht rückgängig zu machen. Daten in bereits erstellten Backups bleiben bis zu deren Ablauf erhalten.

## 6. Betroffenenrechte – wie in der Software

| Recht | Umsetzung |
|---|---|
| Auskunft (Art. 15) und Datenübertragbarkeit (Art. 20) | Mitarbeiter-App → Einstellungen → **Meine Daten**: Download als CSV (Tabellenprogramm) oder JSON (vollständig, maschinenlesbar). Der Inhaber kann dieselbe Auskunft im Chef-Portal → Datenschutz für jede Person erstellen (ohne Konto-/Sitzungsdaten). Jeder Abruf wird protokolliert (`employee.data_export`). |
| Berichtigung (Art. 16) | Stammdaten durch Leitung/Inhaber; Arbeitszeiten über Korrekturanfrage bzw. Korrektur durch die Leitung mit Begründung |
| Löschung (Art. 17) | Anonymisierung nach Ablauf der Aufbewahrungsfrist (Abschnitt 5); vorher stehen gesetzliche Aufbewahrungspflichten entgegen – Prüfung durch den Verantwortlichen |
| Einschränkung, Widerspruch | organisatorisch durch den Verantwortlichen (Deaktivierung sperrt den Zugang) |

Inhalt der Datenauskunft: Person (Stammdaten, Statusverlauf), Konto (Anmeldeadresse, Sitzungen,
Zwei-Faktor-Status – nur bei Abruf durch die Person selbst), Arbeitszeiten inkl. gelöschter, Änderungsverlauf,
Monatsnachweise, Arbeitszeitkonto, Korrekturanfragen, Protokolleinträge zur Person. Format-Kennung
`stundenwerk.personal-data.v1`.

Gesamtexport der Firma (Inhaber, Chef-Portal → Datenschutz): Firmenprofil, Lizenz, alle Mitarbeitenden mit
denselben Inhalten wie oben (ohne Konto-/Sitzungsdaten), Änderungsprotokoll; CSV mit allen Arbeitszeiten.
Format-Kennung `stundenwerk.tenant-data.v1`.

## 7. Offene Punkte (vom Auftraggeber zu entscheiden bzw. zu prüfen)

- Rechtsgrundlagen, Fristen und Vertragstexte (VVT, AV-Vertrag, Datenschutzhinweise für Beschäftigte).
- Ob einzelne Lesezugriffe des Supports protokolliert werden müssen (derzeit nur Erteilen/Widerrufen der
  Freigabe).
- Automatische Bereinigung abgelaufener Sitzungen/Einmal-Links und eine Frist für das Änderungsprotokoll.
- Aufbewahrungsdauer der Backups (lokal und offsite) im Löschkonzept festlegen.
- Datenschutz-Folgenabschätzung: voraussichtlich nicht erforderlich (keine besonderen Kategorien, keine
  Überwachung über die Arbeitszeit hinaus) – **zu prüfen**.
