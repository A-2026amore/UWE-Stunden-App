# Sicherheit und Datenschutz (technisch)

> Rechtliche Aussagen in diesem Dokument sind **zu prüfen, keine Rechtsberatung**.
> Verbindliche Entscheidungen trifft der Auftraggeber, ggf. mit Datenschutzbeauftragtem/Anwalt.

## 1. Mandantentrennung

- Jede fachliche Tabelle trägt `tenant_id`; Kindtabellen referenzieren `(employee_id, tenant_id)`,
  sodass die Mandanten-ID nicht von der des Mitarbeiters abweichen kann.
- **Row Level Security** ist auf allen Tabellen in `public` und `auth` aktiv. Die Richtlinien
  (`db/migrations/0005_rls.sql`) gelten für die Anfragerolle `app_user`; ohne passende Richtlinie
  gibt es keine Zeile.
- Die API kann RLS nicht umgehen: Ihre Login-Rolle `app_api` ist `NOINHERIT` und hat selbst keine
  Tabellenrechte. Jede Anfrage läuft in einer Transaktion mit
  `set local role app_user` und `set_config('request.jwt.claims', '{"sub":"<user-uuid>"}', true)`.
  `auth.uid()` liest diese Einstellung. Die Benutzer-ID setzt **ausschließlich** die API nach
  geprüfter Sitzung – nie ungeprüft aus Client-Eingaben.
- Mitgliedschaften wirken nur bei Mandantenstatus `active`. Ein gesperrter (`suspended`) oder noch
  nicht freigeschalteter (`pending`) Mandant ist für alle seine Mitglieder vollständig gesperrt
  (lesen und schreiben, auch Inhaber). Plattformpersonal sieht weiterhin die Metadaten.
- Prüfungen im Frontend dienen nur der Bedienbarkeit; die Sicherheitsgrenze ist die Datenbank.
- Automatisierte Tests (`tests/db/tenant-isolation.test.ts`) prüfen für jede Tabelle, dass Nutzer
  von Mandant A Zeilen von Mandant B weder lesen, anlegen noch ändern können.

## 2. Rollen

**Mandantenrollen** (`employees.role`):

| Rolle | Darf |
|---|---|
| employee | eigene Zeiten, eigenes Arbeitszeitkonto, eigener Monatsabschluss (einreichen), Branding/Einstellungen des eigenen Mandanten lesen |
| manager | alle Daten des eigenen Mandanten lesen, Mitarbeiter (Rolle employee) anlegen/einladen/deaktivieren, Abschlüsse/Zuweisungen prüfen, Korrekturen mit Begründung |
| owner | wie manager, zusätzlich Firmenprofil/Branding/Einstellungen, Leitungsrollen vergeben, freigegebene Monate wieder öffnen, Support-Zugriff erteilen |

Schutz vor Rechteausweitung (Trigger `employees_guard`): niemand ändert die eigene Rolle, den
eigenen Status oder die eigene Personalnummer; `tenant_id` und `user_id` sind unveränderlich;
neue Zeilen erhalten kein Benutzerkonto (Verknüpfung nur über Einladung); Leitungsrollen vergibt
nur der Inhaber. Vier-Augen-Prinzip: Leitung gibt eigene Abschlüsse/Zuweisungen nicht selbst frei
(Ausnahme Inhaber – in Kleinbetrieben notwendig, im Audit sichtbar). `platform_admins` ist für
Anfragerollen nur lesbar.

**Plattformrollen** (`platform_admins.role`): `super_admin` verwaltet Mandanten und Lizenzen;
`support` hat nur Lesezugriff auf Metadaten. Beide sehen **ohne Freigabe keine personenbezogenen
Daten** (Mitarbeiter, Zeiten, Konten, Abschlüsse, Revisionen) – nur Mandanten-Metadaten, Lizenz
und Mitarbeiterzahlen (`platform_list_tenants()`).

**Datenbankrollen**: siehe `docs/database.md` (`app_api`, `app_user`, `app_anon`, `app_auth`, `app_service`).

## 3. Support-Zugriffskonzept

1. Der **Inhaber** erteilt per `grant_support_access(tenant, stunden, anlass, person?)` eine
   Freigabe (1–168 h; Tabellenobergrenze 30 Tage), optional nur für eine bestimmte Person.
2. Solange die Freigabe gilt (`starts_at ≤ now() < expires_at`, nicht widerrufen), darf das
   Plattformpersonal die personenbezogenen Daten **dieses einen Mandanten lesen** – nicht ändern.
3. Nach Ablauf oder Widerruf (`revoke_support_access`) ist der Zugriff sofort wieder gesperrt.
4. Erteilung und Widerruf landen im Audit-Log; Inhaber und Leitung sehen alle Freigaben.

Offen: Die einzelnen **Lesezugriffe** des Supports werden derzeit nicht protokolliert (RLS kann
SELECTs nicht auditieren). Vorschlag: Support-Ansichten nur über eigene, protokollierende
API-Endpunkte bzw. `pgaudit` auf dem Server.

## 4. Anmeldung (eigener Server)

- Passwörter hasht die API (Node `crypto.scrypt`, keine zusätzliche Abhängigkeit); die DB speichert
  nur den Hash in `auth.users.password_hash`.
- Sitzungs-, Passwort-Reset- und Einladungs-Tokens erzeugt die DB (`gen_random_uuid`, 244 Bit) und
  gibt sie **einmalig** zurück; gespeichert wird nur der SHA-256-Hash.
- Sitzungen: absolute Laufzeit (`expires_at`) plus Leerlauf-Timeout. `auth.resolve_session(token,
  leerlauf_minuten = 120)` aktualisiert `last_seen_at` und widerruft Sitzungen, die länger als die
  Leerlaufzeit unbenutzt waren.
- Passwort-Reset: Token 1 h gültig, einmal verwendbar, widerruft alle Sitzungen.
- Einladung für eine E-Mail-Adresse, zu der es **bereits ein Konto** gibt (z. B. Person arbeitet für
  zwei Mandanten): `auth.accept_invitation(token, passwort_hash)` lehnt ein neu eingegebenes Passwort
  mit Fehler `PT409` ab („Für diese E-Mail-Adresse gibt es bereits ein Benutzerkonto. Bitte melde dich
  mit deinem bisherigen Passwort an …“) – das bestehende Passwort wird nie still überschrieben oder
  ignoriert. Mit `passwort_hash = NULL` wird die Mitgliedschaft ohne Passwortänderung mit dem
  bestehenden Konto verknüpft (der Besitz des Einladungslinks an diese Adresse genügt wie beim
  Passwort-Reset). `auth.invitation_needs_existing_login(token)` sagt der API vorab, welcher Fall vorliegt.
- Anmelde-E-Mail: Die Adresse in `auth.users` ist die einzige Anmelde-Adresse. Ist ein Mitarbeiter
  mit einem Konto verknüpft, kann `employees.email` nicht mehr über die Anfragerollen geändert werden
  (auch nicht von Leitung/Inhaber). Bewusst **keine Synchronisierung** nach `auth.users`: Sonst könnte
  die Leitung eines Mandanten die Anmelde-Adresse einer Person ändern, die auch zu anderen Mandanten
  gehört, und über „Passwort vergessen“ das Konto übernehmen. Adressänderungen verknüpfter Konten
  erledigt die Plattformverwaltung (Wartungszugang) nach Prüfung.
  `create_password_reset` gibt für unbekannte Adressen `NULL` zurück – die API muss in beiden
  Fällen gleich antworten (keine Kontenaufzählung).
- `auth.*` ist nur für `app_auth` und SECURITY-DEFINER-Funktionen zugänglich, nie für `app_user`.
- Offen/zu ergänzen in der API: Rate-Limiting/Sperre bei Fehlversuchen, HttpOnly-/Secure-/SameSite-Cookies,
  CSRF-Schutz, Zwei-Faktor (TOTP) als nächste Stufe.

## 5. Integrität und Nachvollziehbarkeit

- Zeiten werden nie physisch gelöscht (Soft-Delete); jede Änderung erzeugt eine Revision.
- Optimistische Sperre über `version`; Konflikte führen zu Fehler `PT409` statt stillem Überschreiben.
- Freigegebene Monate sind gesperrt; Korrekturen nur durch die Leitung mit Begründung, im Audit-Log.
  Die interne Korrekturkennung (`app.statement_correction`) wirkt nur innerhalb der
  SECURITY-DEFINER-Funktion; setzt eine Anfragerolle sie selbst, wird sie ignoriert (getestet).
- Logos/Zeichen: nur PNG, JPEG, WebP (Data-URL), `https://` oder relative Pfade; SVG-Data-URLs werden
  in der Datenbank abgelehnt (SVG kann Skripte enthalten). Die API prüft zusätzlich Größe und Dateisignatur.
- `audit_log` ist append-only (UPDATE/DELETE/TRUNCATE werden auch für den Superuser abgelehnt,
  solange der Trigger aktiv ist). Anfragerollen können keine Audit-Einträge schreiben.
- Alle SECURITY-DEFINER-Funktionen setzen `search_path = ''` und verwenden voll qualifizierte Namen.

## 6. Secrets

- **Niemals** Passwörter, Verbindungs-URLs mit Passwort, private Schlüssel oder Tokens ins Repository.
- CI: Zugangsdaten nur als **GitHub Secrets**; die DB-Tests brauchen keine Secrets (Wegwerf-Container).
- Server: Verbindungsdaten in einer Umgebungsdatei außerhalb des Repos (Rechte `600`) oder in einem
  Secret-Manager; `app_api`-Passwort setzt der Betrieb: `alter role app_api login password '…'`.
- PostgreSQL nur lokal/über privates Netz erreichbar, `pg_hba.conf` mit `scram-sha-256`, TLS bei
  Netzzugriff; Backups verschlüsselt.
- Seed-Daten sind ausschließlich erfundene Demodaten (`*.example`-Adressen, Fantasienamen).

## 7. DSGVO – technische Hinweise (zu prüfen, keine Rechtsberatung)

**Datensparsamkeit:** Gespeichert werden nur Name, Personalnummer, dienstliche E-Mail, Rolle,
Arbeitszeiten mit Notiz (max. 500 Zeichen). Keine Gesundheits-, Standort- oder Gerätedaten.
Notizfelder sollten in der App mit Hinweis „keine Patientendaten eintragen“ versehen werden.

**Löschkonzept (Vorschlag, Fristen vom Auftraggeber festzulegen):**

| Daten | Vorschlag |
|---|---|
| Arbeitszeiten, Revisionen, Abschlüsse | Aufbewahrung nach gesetzlicher Pflicht (z. B. §16 Abs. 2 ArbZG mind. 2 Jahre; steuer-/lohnrelevante Unterlagen ggf. länger – *zu prüfen*), danach Löschung durch Wartungsjob als `app_service` (physisch, inkl. Revisionen per Kaskade) |
| Deaktivierte Mitarbeiter | Stammdaten nach Ablauf der Fristen anonymisieren (Name/E-Mail ersetzen) |
| Sitzungen, Einmal-Tokens | abgelaufene nach 30 Tagen löschen |
| Audit-Log | Frist festlegen; Löschung erfordert bewusste Wartungsmigration (Trigger), da append-only |
| Gekündigter Mandant | Export an den Kunden, danach vollständige Löschung (`delete from tenants` als Wartung, Kaskade) |

**Auftragsverarbeitung (offene Entscheidung des Auftraggebers):** AV-Vertrag mit dem Hoster
(z. B. Hetzner) und – sofern der Betrieb für andere Firmen erfolgt – AV-Verträge mit jedem
Kundenmandanten; Verzeichnis der Verarbeitungstätigkeiten; TOMs dokumentieren. Prüfen, ob die
Support-Freigabe vertraglich geregelt werden muss.

**Betroffenenrechte:** Auskunft/Export je Mitarbeiter lässt sich aus `time_entries`,
`time_entry_revisions`, `work_account_allocations`, `monthly_statements`, `audit_log` erzeugen
(Wartungsjob/Export-Endpunkt – noch nicht umgesetzt).
