# Changelog

Format nach [Keep a Changelog](https://keepachangelog.com/de/1.1.0/), Versionen nach SemVer.

## [Unveröffentlicht] – Plattform 0.1.0 (Branch `develop`)

### Hinzugefügt
- Neues Design „Stundenwerk“ (Branch `feature/design-stundenwerk`, Doku `docs/design.md`):
  - Produktname „Stundenwerk“ ohne Zusatz „Arbeitstitel“, eigenes Produktlogo (inline SVG).
  - Hell- und Dunkelmodus (System/Hell/Dunkel, lokal gespeichert) für alle Bereiche; Firmenfarben werden für
    beide Modi automatisch kontrastsicher (WCAG AA) abgeleitet, Firmenlogos im Dunkelmodus auf heller Plakette.
  - Schrift Inter lokal eingebunden (OFL), neue Tokens für Farben, Abstände, Radien, Schatten, Bewegung;
    Animationen respektieren `prefers-reduced-motion`; Skeleton-Ladeanzeige.
  - Zweigeteilte Anmeldeseiten (Mitarbeiter, Chef, Admin, Passwort neu, Einladung, 2FA), mobil einspaltig,
    mit Firmenlogo, wenn auf dem Gerät bekannt.
  - Chef-Portal und Super-Admin: Seitenleiste mit Gruppen und Zählern, Farbschema-Umschalter; Chef-Dashboard mit
    Kennzahlen (inkl. Kosten des Monats), SVG-Balkendiagramm Stunden je Tag/Woche und Stunden je Person.
  - Mitarbeiter-App: neue Kopfzeile, Tab-Leiste mit hervorgehobenem „Erfassen“, Safe-Area, Tagesdiagramm in
    der Monatsübersicht, Darstellung im Profil.
  - PDF-Stundennachweis: Infofeld, farbiger Tabellenkopf, Zebra-Streifen, Wochentage, Summenblock, Fußzeile mit
    Erstellungsdatum, Produktname und „Seite x von y“ – weiterhin mehrseitig mit unveränderten Seitenumbrüchen.
  - Statusanzeigen für „Wieder geöffnet“, „Storniert“, „Stornorechnung“, „Ausgestellt“; Super-Admin „Rechnungen“ in
    der Seitenleiste (Gruppe „Kunden“), Verlauf, Wiederöffnung und Rechnungen im neuen Design.
- Wiederöffnung, Sperr-Abrechnung und Rechnungen (Branch `feature/wiedereroeffnung-rechnungen`, Migrationen
  `0017_statement_reopen.sql`, `0018_tenant_status_billing.sql`, `0019_invoices.sql`; Entscheidungen vom 28.10.2026):
  - N1 entschieden: Ein freigegebener Monat ist für alle gesperrt – auch für Korrekturen der Leitung und angenommene
    Korrekturanfragen (`PT423` in der Datenbank). Chef-Portal „Monat wieder öffnen“ (Begründung Pflicht, Audit), danach
    Korrekturen und „Erneut freigeben“ bzw. Zurückgeben; die Zahlen werden bei jeder Freigabe neu berechnet. Verlauf je
    Nachweis (`monthly_statement_events`, Chef-Portal „Verlauf“), Mitarbeiter-App zeigt „Wieder geöffnet“ mit Grund.
    Die Abrechnung ändert sich durch eine Wiederöffnung nicht. API `POST /api/statements/:id/reopen`,
    `GET /api/statements/:id/events`.
  - Gesperrte/deaktivierte Firmen kosten ab dem Folgemonat 0 € (Statushistorie `tenant_status_history`, Monatsgrenzen
    Europe/Berlin). Super-Admin „Umsatz“ zeigt Datum und Grund, Chef-Portal „Abrechnung“ den Hinweis ohne Grund.
  - Rechnungen: Super-Admin „Rechnungen“ (Absenderangaben nach § 14 UStG, Entwurf, Rechnung erzeugen, PDF, Storno mit
    Grund), Nummern `SW-JJJJ-000001` lückenlos je Jahr, Storno mit eigener Nummer, Inhalte eingefroren, USt 19 % mit
    Hinweis „vom Auftraggeber zu bestätigen“, Zahlungsziel als Einstellung; ohne Pflichtangaben nur Entwurf mit
    Wasserzeichen. PDF mehrseitig (`platform/src/core/invoice.ts`). Inhaber sieht eigene Rechnungen unter „Abrechnung“.
    Kein Versand, keine Zahlungsabwicklung.
  - Geändert: „Zurückgeben“ gibt freigegebene Nachweise nicht mehr zurück (409) – dafür „Monat wieder öffnen“. Die
    Kennzeichnung „nach Freigabe korrigiert“ bleibt nur für Altfälle.
- Datenschutz, Sicherheit und Wiederherstellbarkeit (Branch `feature/sicherheit-dsgvo-backup`, Migration
  `0016_privacy.sql`, Doku `docs/datenschutz.md` – Entwurf, rechtlich prüfen):
  - Datenauskunft (Art. 15/20 DSGVO): Mitarbeiter-App → Einstellungen → „Meine Daten“ (CSV oder JSON, inkl.
    Anmeldesitzungen und 2FA-Status); der Inhaber erstellt dieselbe Auskunft im Chef-Portal → „Datenschutz“.
    Jeder Abruf wird protokolliert. API `GET /api/employees/:id/data-export[?format=csv]`.
  - Anonymisierung ausgeschiedener Mitarbeitender nach einer vom Inhaber festgelegten Aufbewahrungsfrist
    (1–600 Monate, ohne Frist keine Anonymisierung; keine Frist vorgegeben). Nur deaktivierte Personen, nach
    Ablauf der Frist, mit Bestätigung der Personalnummer, protokolliert; Arbeitszeiten bleiben ohne Personenbezug
    erhalten. API `PUT /api/tenants/:id/privacy`, `POST /api/employees/:id/anonymize`.
  - Gesamtexport aller Firmendaten für den Inhaber (z. B. bei Kündigung), JSON und CSV.
    API `GET /api/tenants/:id/data-export[?format=csv]`. Demo-Repository verhält sich gleich.
  - Verschlüsselte Datenbank-Sicherung `deploy/backup.sh` (pg_dump Custom-Format, Rollen ohne Passwörter,
    Manifest aus demselben Schnappschuss, GPG mit öffentlichem Schlüssel oder Passphrase, SHA-256, Übergabe an
    restic per `BACKUP_HOOK`, `BACKUP_STATUS_FILE` für „Letzte Sicherung“) und Wiederherstellungsprobe
    `deploy/restore-test.sh` (Wegwerf-Cluster/-Container, prüft Zeilenzahlen, Migrationsstand, RLS).
    Anleitung `docs/betrieb.md` 5.1. Bestehende Server-Backup-Konfiguration unverändert.
  - Testzugänge für die Testumgebung: `cli.ts seed-test-env --confirm-test-environment` (Testfirma Gratis und
    Testfirma Zahlend mit Inhaber, Leitung, drei Mitarbeitenden, Super-Admin mit Pflicht-2FA; Zufallspasswörter
    nur in der Konsole; verweigert bei echten Mandanten). Ablauf zum Aktualisieren von
    `stunden-test.appzentrale24.de` in `deploy/README.md`.
  - CI: Container-Job legt Testzugänge an, sichert per Compose und führt die Wiederherstellungsprobe aus.
- Chef-Portal/Super-Admin Feinschliff (Branch `feature/chef-admin-feinschliff`):
  - Chef-Portal „Stundenübersicht“ (`#/stunden`): alle Mitarbeitenden eines Monats mit Summen und Nachweis-Status,
    Einzelansicht je Person mit Tagesliste, Summenzeile, Freigeben/Zurückgeben, PDF-Stundenzettel und CSV
    (Monatssummen, alle Einsätze, einzelne Person – Formel-Neutralisierung wie bisher).
  - „Zugang senden“: Einladung per E-Mail (SMTP) oder als Einmal-Link zum Kopieren / Teilen per WhatsApp (wa.me),
    Gültigkeit sichtbar, ein neuer Link macht ältere ungültig, nie ein Passwort. Hat die Adresse bereits ein Konto,
    wird der Link aus Sicherheitsgründen nur per E-Mail an diese Adresse geschickt. API: `invitation`/`channel`
    = `email` | `link`.
  - PDF-Monatsnachweis mit Firmenlogo (PNG/JPG/WebP, als JPEG eingebettet) und Firmenname im Kopf, weiterhin mehrseitig.
  - Firmenname im Firmenprofil durch den Inhaber änderbar (`PATCH /api/tenants/:id/name`). Demo nimmt wie die API
    keine SVG-Logos mehr an.
  - Super-Admin: Mandantenstatus „deaktiviert“ zusätzlich zu „gesperrt“ (Migration
    `0015_tenant_deactivation_system_overview.sql`, keine Daten gelöscht, Zugang gesperrt mit eigener Meldung);
    kostenlosen Testkunden in einem Schritt anlegen; Kennzahlen Mitarbeitende gesamt und Umsatz netto im Überblick;
    Statusfilter; Audit-Einträge mit verständlichen deutschen Bezeichnungen.
  - Technische Systemübersicht (`GET /api/platform/system`, nur super_admin/support): Version, Commit (`APP_COMMIT`),
    Datenbank erreichbar, Migrationsstand, aktive Sitzungen, E-Mail-Versand ja/nein, Zahlungsanbieter „keiner“,
    letzte Sicherung (`BACKUP_STATUS_FILE`, sonst „nicht bekannt“) – ohne Geheimnisse.
  - Mitarbeiter-App: Hinweis „Zum Home-Bildschirm hinzufügen“ (Startseite ausblendbar, Einstellungen ausführlich;
    iPhone-Anleitung bzw. Installationsdialog), zusätzliche iOS/Android-Meta-Tags; Apple-Touch-Icon für Chef/Admin.
- Pausen nur noch tatsächlich genommen (Vorgabe 28.10.2026): Pausenfeld der Mitarbeiter-App startet leer,
  kein automatischer Vorschlag mehr, Pflichtfeld (0 erlaubt); Hinweis nennt die Mindestpause des Tages und
  die Regel; zu kurze Pause wird mit freundlicher Erklärung nicht gespeichert (auch im Korrekturdialog des
  Chef-Portals). Doku: `docs/pausenregeln.md`.
- Pausenregel je Mandant wählbar: „gesetzlich“ (mehr als 6/9 h, 361/541 Min., Standard für neue Mandanten –
  an einer Stelle `NEW_TENANT_BREAK_RULE` in `core/breaks.ts`) oder „streng“ (ab genau 6/9 h, UWE). Der
  Inhaber schaltet im Chef-Portal um; alle Texte werden aus der Konfiguration gebildet („ab 6 Stunden“ /
  „mehr als 6 Stunden“). Laxere Regeln als § 4 ArbZG lehnen Core, API, Demo und Datenbank ab
  (Migration `0014_break_policy_statutory.sql`). Demo-Mandant „Muster Pflegedienst“ nutzt wie im Seed die
  gesetzliche Regel; der UWE-Nachbau bleibt streng.
- Korrekturanfragen (Migration `0013_correction_requests.sql`): Mitarbeitende beantragen für eigene Einträge eine
  Änderung, Löschung oder einen fehlenden Eintrag – vor allem in eingereichten/freigegebenen Monaten – mit Pflichtbegründung;
  Status offen/angenommen/abgelehnt/zurückgezogen. Die Leitung nimmt im Chef-Portal an (Übernahme als Korrektur mit
  Revision und Audit, gleiche Regeln wie bei der Erfassung: Pausen, 12 h, Überschneidung, Vier-Augen) oder lehnt mit
  Begründung ab. Menüpunkt und Dashboard-Kachel „Offene Korrekturanfragen“, Verlauf (Revisionen) je Eintrag auch unter
  „Arbeitszeiten“. Freigegebene Monate, die nachträglich korrigiert wurden, sind als „nach Freigabe korrigiert“ markiert
  (Sicht `statement_correction_flags`); die freigegebenen Zahlen bleiben unverändert – offene Entscheidung N1
  (`docs/database.md`). API: `/api/tenants/:id/correction-requests`, `/api/employees/:id/correction-requests`,
  `/api/correction-requests/:id/withdraw|decide`, `/api/employees/:id/time-entries/:entryId/revisions`; Statements mit
  `correctedAfterApproval`. Anfragen nur online (klare Meldung offline). Bedienung: `docs/bedienung-korrekturen.md`.
  Demo: Löschen durch die Leitung setzt wie auf dem Server die Herkunft „Korrektur“; Verlauf wird ab jetzt aufgezeichnet.
- Preismodell (Entscheidung vom 28.10.2026, `docs/preismodell.md`): 5,00 € netto je abrechenbarem Mitarbeiter
  und Monat, keine Grundgebühr/Mindestanzahl/Staffeln. Migration `0012_billing.sql`: Mitarbeiterstatus „gesperrt“
  (`locked`), Statushistorie per Trigger (Bestand aus dem Audit-Log), Standardpreis (`billing_settings`),
  Sonderkonditionen in `licenses` (Sonderpreis, kostenloses Konto, Notiz, Gültigkeit; `pilot_free` bleibt
  kostenlos), Abrechnungsfunktionen in SQL (Europe/Berlin), Abrechnungsstatus je Mandant und Monat
  (offen/in Rechnung gestellt/bezahlt/erlassen) mit Festschreibung beim Abschluss und Audit.
  Fachlogik `platform/src/core/billing.ts`, API-Routen `/api/tenants/:id/billing*`, `/api/platform/billing*`,
  Chef-Portal „Abrechnung“ und Sperren/Entsperren, Super-Admin „Umsatz“ und „Preismodell“, Sonderkonditionen je
  Mandant. Zahlungsdienstleister nur vorbereitet (`server/src/payment.ts`, einzige Umsetzung `none`,
  `PAYMENT_PROVIDER`). Tests: DB, Server, Unit, E2E (Demo).
- Betreiberbefehl `cli.ts invite-link <mandant> <email> <rolle>` (QA 2026-10-28, B1): Einladungslink ohne
  E-Mail, Ausgabe nur auf der Konsole; Migration `0010_operator_invitation.sql`.
- Container-Betrieb: mehrstufiges `Dockerfile` (Node 22, Lockfile, Nicht-root, API liefert die gebauten
  Oberflächen aus), `deploy/docker-compose.yml` mit PostgreSQL 16 im internen Netz, externem Netz `proxy`,
  Backup-Label und Healthchecks, `deploy/.env.example`, `deploy/README.md`. Migrationsjob
  `server/src/migrate.ts` (Versionstabelle `ops.schema_migrations`, Prüfsummen, Passwort für `app_api`).
  `pg` ist jetzt Laufzeitabhängigkeit. CI baut und startet das Image (kein Push).
- API: `TRUST_PROXY_CIDRS` – `X-Forwarded-For` nur von Absendern aus den angegebenen Netzen.
- Entwicklungswerkzeuge: Vite, TypeScript, Preact, Vitest, Playwright, ESLint.
- GitHub Actions: Lint, Typecheck, Unit-, Datenbank- und Browsertests, Build-Artefakt,
  Geheimnis-Scan, CodeQL, Dependabot; Pull-Request- und Issue-Vorlagen.
- Geheimnis-Scan: `.gitleaks.toml` nimmt Testdateien (nur Testpasswörter/-schlüssel) und
  Speicherschlüssel-Namen der Alt-App (`uwe_…`) als Fehlalarme aus.
- API: CORS-Antwort übernimmt nur noch den konfigurierten Origin-Wert, `null` wird nie akzeptiert (CodeQL).
- Ist-Analyse, Architektur (eigener Server in Deutschland), Migrationsplan, Betriebshandbuch.
- Fachlogik (`platform/src/core`): Pausenregeln, Arbeitszeitkonto (Schuljahr/Kalenderjahr,
  konfigurierbar), Migration, mehrseitiges PDF; Vergleichstests gegen die Alt-App.
- PostgreSQL-Schema (`db/`) mit Row Level Security, Revisionen, Soft Delete, Audit-Log,
  Support-Freigaben, Lizenzen inkl. kostenlosem Pilot; Härtung (Migration 0008).
- Eigene Node-API (`server/`): Anmeldung mit Sitzungs-Cookie, Passwort vergessen, Einladungen,
  Rate-Limits, CSRF-Schutz, serverseitige Pausenprüfung.
- Designsystem mit White-Label und Demo von Mitarbeiter-App, Chef-Portal und Super-Admin.
- Offline-Erfassung mit Synchronisierung und Konfliktbehandlung; Übernahme der Altdaten
  (Backup-Datei oder Browser-Speicher) mit Bericht vor dem Schreiben.
- Produktionsmodus (`npm run build:api`): Apps arbeiten gegen die eigene API; Seiten „Passwort neu setzen“
  und „Einladung annehmen“; Service Worker nur für die Mitarbeiter-App (Offline-Start); Gesamttests mit
  echter Datenbank.
- Zwei-Faktor-Anmeldung (TOTP nach RFC 6238, Authenticator-App): freiwillig für alle Konten, Pflicht für
  Plattformkonten (`super_admin`, `support`) und – wenn der Inhaber es einschaltet – für Inhaber und Vorgesetzte
  eines Mandanten. Anmeldung in zwei Schritten, Einrichtung mit QR-Code (eigener Encoder) in den Einstellungen
  aller drei Bereiche, 10 Wiederherstellungscodes (Anzeige und Textdatei), Deaktivieren nur mit Passwort und Code.
  Geheimnis AES-256-GCM-verschlüsselt (`TOTP_ENCRYPTION_KEY`, Rotation über `TOTP_ENCRYPTION_KEY_PREVIOUS`),
  Replay-Schutz, Rate-Limits, Audit-Einträge. Migration `0009_two_factor.sql` (nur additiv).
  Demo: Geheimnis im Browser, Schaltfläche „Demo: aktuellen Code einsetzen“.
- Tests: 284 Unit-, 209 Datenbank-/API-, 122 Browsertests (Demo-Build und Alt-App, Chromium Desktop und
  Android-Emulation) sowie 18 Full-Stack-Tests je Projekt (Stand 27.10.2026).

### Sicherheit (QA 2026-10-28)
- Sicherheitsprüfung release/1.0 (Ergebnis `docs/security.md` Abschnitt 8): Fehlanmeldungen und Reset-Mails
  werden zusätzlich je E-Mail-Adresse über alle IPs begrenzt (`RATE_LIMIT_LOGIN_PER_EMAIL`, Standard 30;
  `RATE_LIMIT_RESET_PER_EMAIL`, Standard 10) – Schwere mittel, behoben. Neuer Test ruft **jede** registrierte
  API-Route mit fremden Rollen auf (`tests/server/route-isolation.test.ts`; neue Routen ohne Einstufung lassen ihn
  scheitern), Katalogprüfung aller Migrationen (`tests/db/security-catalog.test.ts`), Sichtbarkeit des
  Mandanten-Protokolls für Plattformpersonal (`tests/server/platform-audit-visibility.test.ts`, keine Lücke).
- B3: Firmenprofil (Branding, Kontakt, Einstellungen, Name) ändert nur noch der Inhaber. Plattformpersonal hat
  keinen Schreibzugriff mehr auf Mandantenzeilen, auch nicht mit Support-Freigabe; Statuswechsel nur über
  `set_tenant_status` (jetzt SECURITY DEFINER mit Super-Admin-Prüfung). Migration `0011_tenant_profile_owner_only.sql`.
  Demo-Repository und Chef-Portal angeglichen: Firmenprofil und Einstellungen nur für den Inhaber, Leitung sieht das
  Firmenprofil schreibgeschützt.
- B4: Anmeldung eines gesperrten Kontos verrät die Sperre (und damit das richtige Passwort) nicht mehr: mit 2FA
  folgt die 403-Meldung erst nach dem richtigen Code, ohne 2FA lautet die Antwort wie bei falschem Passwort (401).
- B5: Herkunft `source: "migration"` (Altdaten-Übernahme) nur noch für eigene Einträge der angemeldeten Person;
  Leitung kann Einträge anderer nicht als „Übernahme“ markieren (403).
- B6: CSV-Export der Arbeitszeiten (Chef-Portal) schützt vor Formel-Injektion: Freitexte, die mit `=`, `+`, `-`,
  `@` (auch nach führendem Leerraum), Tab oder CR beginnen, erhalten ein vorangestelltes `'` (`platform/src/core/csv.ts`); Quelle „Übernahme“
  wird im Export ausgewiesen.
- B7: Stilllegen/Löschen von Mandanten dokumentiert (`docs/betrieb.md`, 6.1a); weiterhin kein API-Endpunkt.

### Bekannte Fehler der Alt-App (dokumentiert, nicht geändert)
- Überschneidung über Mitternacht wird nicht erkannt.
- Beschädigter Stundenspeicher kann beim nächsten Speichern überschrieben werden.
- Nicht existierende Daten (z. B. 30.02.) werden akzeptiert.
- Lücke vor einem Nachteinsatz zählt nicht als Pause (fachlich zu klären).

### Unverändert
- Produktive UWE-App (Version 27) im Repository-Stamm.

## Bestehende App
- Version 27 (26.10.2026): Monatsstunden für die Abrechnung nach Übertragung ins Arbeitszeitkonto.
- Ältere Versionen: siehe Git-Historie von `main`.
