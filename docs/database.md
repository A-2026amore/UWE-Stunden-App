# Datenbank

Selbst betriebenes **PostgreSQL 16** (eigener Server in Deutschland). Das Schema liegt als
reine SQL-Migrationen in `db/migrations/NNNN_name.sql`, Demodaten in `db/seed.sql`.
Kein Supabase, kein PostgREST: Davor sitzt eine eigene Node-API (siehe `docs/api.md`).

| Datei | Inhalt |
|---|---|
| `0001_roles_auth.sql` | Rollen (idempotent), Erweiterung `btree_gist`, Schemas `auth`/`private`, Anmeldetabellen, `auth.uid()`/`auth.jwt()` |
| `0002_tables.sql` | Fachtabellen, JSON-Validierung (Branding, Kontakt, Einstellungen), Constraints |
| `0003_access_helpers.sql` | Hilfsfunktionen für RLS (Mitgliedschaft, Rollen, Support-Freigabe, Monatssperre) |
| `0004_integrity_triggers.sql` | Schutz-Trigger (Versionierung, Sperren, Rollen), Revisionen, Audit, Unveränderlichkeit |
| `0005_rls.sql` | Row-Level-Security-Richtlinien |
| `0006_functions.sql` | RPC-Funktionen (Zeiten, Konto, Monatsabschluss, Einladungen, Support, Plattform, Anmeldung) |
| `0007_grants.sql` | Rechtevergabe je Rolle |
| `0008_hardening.sql` | Nachschärfung nach API-Review (additiv): nur aktive Mandanten, keine SVG-Data-URLs, Einladung bei bestehendem Konto, Leerlauf-Timeout, Zahlenformat, Mitarbeiterzahlen, E-Mail verknüpfter Konten |
| `0009_two_factor.sql` | Zwei-Faktor-Anmeldung (TOTP), Wiederherstellungscodes, Pflicht für Leitung/Plattform |
| `0010_operator_invitation.sql` | `auth.operator_create_invitation` für den Betreiberbefehl `invite-link` (nur `app_auth`) |
| `0011_tenant_profile_owner_only.sql` | `tenants_update` nur noch für den Inhaber; `set_tenant_status` als SECURITY DEFINER (nur Super-Admin); `tenants_guard` ohne Ausnahme für Plattformpersonal |
| `0012_billing.sql` | Preismodell (`docs/preismodell.md`): Mitarbeiterstatus `locked`, Statushistorie, Standardpreis, Sonderkonditionen in `licenses`, Abrechnungsfunktionen (Europe/Berlin), Abrechnungsstatus mit festgeschriebenen Monaten |
| `0013_correction_requests.sql` | Korrekturanfragen der Mitarbeitenden (`correction_requests`, RPCs anlegen/zurückziehen/entscheiden), Sicht `statement_correction_flags` („nach Freigabe korrigiert“) |
| `0014_break_policy_statutory.sql` | CHECK `tenants_break_policy_statutory`: Pausenregel eines Mandanten nie laxer als § 4 ArbZG (`private.break_policy_meets_statute`), siehe [pausenregeln.md](pausenregeln.md) |
| `0015_tenant_deactivation_system_overview.sql` | Mandantenstatus `deactivated` (Vertrag beendet; keine Anmeldung, **keine Daten gelöscht**, reaktivierbar) zusätzlich zu `suspended` (vorübergehend gesperrt) und `pending`; `set_tenant_status` akzeptiert ihn (nur Super-Admin, Grund Pflicht). `public.platform_system_overview()` (SECURITY DEFINER, Super-Admin und Support): Migrationsstand aus `ops.schema_migrations` (falls vorhanden), Anzahl aktiver Sitzungen, Mandanten je Status – nur Zahlen |

Anwenden (als Superuser bzw. Datenbankeigentümer, in Dateireihenfolge):

```sh
for f in db/migrations/*.sql; do psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f "$f"; done
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f db/seed.sql   # nur Demo/Staging, nie Produktion
```

Für den Container-Betrieb gibt es den Migrationsjob `server/src/migrate.ts` (`deploy/README.md`): Er spielt
nur noch nicht eingespielte Dateien ein (je Datei eine Transaktion), vermerkt Name und SHA-256 in
`ops.schema_migrations` (Schema `ops` nur für den Eigentümer), bricht bei nachträglich veränderten Dateien ab und
setzt optional das Passwort von `app_api` (`APP_API_PASSWORD`). Demo-Daten nur mit `MIGRATE_SEED=1`, nie mit
`NODE_ENV=production`.

## ER-Überblick

```
auth.users ─┬─< auth.sessions
            ├─< auth.one_time_tokens >── public.invitations
            ├─< public.platform_admins (super_admin | support)
            └─< public.employees.user_id (0..1 je Mandant)

public.tenants ─┬─< licenses            (max. 1 aktive je Mandant, inkl. Sonderkondition)
                ├─< support_access_grants
                ├─< billing_periods ─< billing_period_lines >── employees
                └─< employees ─┬─< invitations
                               ├─< employee_status_history
                               ├─< time_entries ─< time_entry_revisions
                               ├─< work_account_allocations
                               ├─< correction_requests  (entry_id → time_entries.id, ohne FK)
                               └─< monthly_statements
public.audit_log   (tenant_id ohne FK – bleibt erhalten)
public.billing_settings (eine Zeile: Standardpreis)
```

Alle mandantenbezogenen Kindtabellen referenzieren `(employee_id, tenant_id)` → `employees(id, tenant_id)`.
Dadurch kann `tenant_id` nie von der des Mitarbeiters abweichen (keine „gefälschte“ Mandanten-ID).

## Tabellen

| Tabelle | Zweck / wichtige Regeln |
|---|---|
| `tenants` | Mandant. `slug` eindeutig, `status` active/suspended/pending/deactivated (nur `active` gibt Mitgliedern Zugriff; `deactivated` seit 0015), `is_demo`. `branding`, `contact`, `settings` als jsonb mit Prüffunktion (Farben `#RRGGBB`; Bild-URLs nur `https://`, relativer Pfad ohne `//`/`..` oder `data:image/png|jpeg|webp;base64` – **kein SVG** seit 0008; WhatsApp nur Ziffern mit Ländervorwahl). Bereits gespeicherte SVG-Data-URLs (vor 0008) werden erst beim nächsten Ändern des Brandings abgelehnt. |
| `licenses` | Tarif `pilot_free/standard/business/enterprise`, `status`, `price_cents` (veraltet, immer 0, ohne Wirkung), `billing none/manual/provider`, `valid_until` NULL = unbegrenzt. CHECK: `pilot_free` ⇒ `price_cents = 0` und `billing = 'none'`. Keine automatische Umstellung (kein Trigger/Job ändert den Tarif). Seit 0012 Sonderkondition: `employee_price_cents` (NULL = Standardpreis, 0–100000), `free_of_charge`, `condition_note`, `condition_valid_from/until` (gilt für jeden berührten Monat). Trigger: `pilot_free` ⇒ `free_of_charge = true` (CHECK); Wechsel weg von `pilot_free` setzt `free_of_charge` zurück, wenn es nicht ausdrücklich mitgeändert wird. |
| `employees` | Mitgliedschaft einer Person in einem Mandanten: `role` employee/manager/owner, `status` invited/active/locked/deactivated (`locked` = vorübergehend gesperrt, seit 0012), `personnel_number` eindeutig je Mandant, `user_id` → `auth.users` (erst nach Annahme der Einladung). `email` ist änderbar, solange kein Konto verknüpft ist; danach gesperrt (Anmelde-Adresse liegt in `auth.users`, siehe `docs/security.md`). |
| `platform_admins` | Plattformpersonal `super_admin` / `support`. Nur per Wartungszugang pflegbar. |
| `support_access_grants` | Vom Inhaber erteilte, befristete Freigabe (max. 30 Tage, per RPC max. 168 h) für Plattformpersonal; optional an eine Person gebunden; widerrufbar. |
| `invitations` | Einladung je Mitarbeiter (Ablauf, angenommen, widerrufen). Der Token liegt nur gehasht in `auth.one_time_tokens`. |
| `time_entries` | Einsatz. Schlüssel **`(tenant_id, employee_id, id)`**: `id` ist die vom Client erzeugte Kennung (`^[A-Za-z0-9_-]{4,100}$`, UUID oder migrierte `legacy-…`-Kennung) und nur **je Mitarbeiter** eindeutig = Idempotenzschlüssel. `version` (optimistische Sperre), `deleted_at` (Soft-Delete), `source` app/migration/correction. Berechnet: `duration_minutes`, `period` (tsrange; Ende ≤ Beginn ⇒ Ende am Folgetag). |
| `time_entry_revisions` | Vollständige Historie: je Insert/Update ein Schnappschuss (per Trigger), mit `operation` insert/update/delete/restore, `is_correction`, `reason`, `changed_by`. Unveränderlich. |
| `work_account_allocations` | Zuweisung ins Arbeitszeitkonto je Mitarbeiter und Monat (`YYYY-MM`), `minutes ≥ 0`, `status` proposed/approved/rejected (Ablehnung braucht Begründung). Nur wenn `settings.workAccount.enabled` und Monat ≥ `startMonth`. Migrierte Zuweisungen kommen mit `proposed`. |
| `monthly_statements` | Monatsabschluss draft/submitted/approved/returned; Zahlen (`worked/allocated/billing_minutes`) berechnet die DB. `returned` ⇒ `review_note` Pflicht (CHECK). |
| `correction_requests` | Korrekturanfrage (seit 0013): `kind` change/delete/add, `entry_id` + `entry_version` (change/delete), `before`/`proposed` als `{date,start,end,pauseMinutes,note}`, `reason` (5–1000 Zeichen, Pflicht), `status` open/accepted/rejected/withdrawn, `decided_at`/`decided_by`/`decision_note` (Pflicht bei Ablehnung), `applied_entry_id`/`applied_version`. Höchstens eine offene Anfrage je Eintrag. Schreiben nur über die RPCs; entschiedene Anfragen sind unveränderlich (Trigger, auch für Wartungscode). |
| `statement_correction_flags` (Sicht) | Freigegebene Monatsabschlüsse, deren Monat **nach** `reviewed_at` korrigiert wurde (Revisionen mit `is_correction`, altes oder neues Datum im Monat): `corrections`, `last_corrected_at`. `security_invoker`: RLS der Abschlüsse und Revisionen gilt. |
| `employee_status_history` | Seit 0012. Gültigkeitszeiträume `[valid_from, valid_to)` von (`status`, `role`) je Mitarbeiter; gepflegt per Trigger `employees_status_history` (SECURITY DEFINER), keine Überschneidung (Exclusion-Constraint), höchstens ein offener Zeitraum. Bestand beim Einspielen aus dem Audit-Log rekonstruiert (`employee.insert/update`), sonst ab `created_at`. Grundlage für „im Monat aktiv“. |
| `billing_settings` | Seit 0012. Genau eine Zeile: `default_price_cents` (Standard 500 = 5,00 € netto je abrechenbarem Mitarbeiter und Monat), `currency = 'EUR'`. Änderung nur über `platform_set_default_price`. |
| `billing_periods` | Seit 0012. Abrechnungsstatus je Mandant und Monat `open/invoiced/paid/waived`. Außer `open` mit **festgeschriebenen** Zahlen (`billable_count`, `unit_price_cents`, `amount_cents = count × price`, `condition`, `plan`, `closed_at`) – CHECK. Nur über `platform_set_billing_status`. |
| `billing_period_lines` | Seit 0012. Festgeschriebene abrechenbare Personen eines abgeschlossenen Monats (`employee_id`, `reason` employee/leader_with_time). Nur für die Leitung des Mandanten sichtbar. |
| `audit_log` | Nur Anfügen. UPDATE/DELETE/TRUNCATE werden für **alle** Rollen per Trigger abgelehnt. |
| `auth.users`, `auth.sessions`, `auth.one_time_tokens` | Anmeldung: E-Mail (klein geschrieben, eindeutig), Passwort-Hash (scrypt aus der API), Sitzungen und Einmal-Tokens **nur als SHA-256-Hash**. Nur Rolle `app_auth` und SECURITY-DEFINER-Funktionen. |

### Harte Regeln in der Datenbank

| Regel | Umsetzung |
|---|---|
| Keine Überschneidung von Einsätzen desselben Mitarbeiters (inkl. Nachtschicht) | Exclusion-Constraint `time_entries_no_overlap` (gist, `employee_id =`, `period &&`, nur nicht gelöschte) → Fehler `23P01` |
| Max. 12 h je Einsatz | CHECK `duration_minutes between 1 and 720` + Trigger mit strengerem Mandantenwert `breakPolicy.maxShiftMinutes` → `23514` (Meldung mit deutschem Zahlenformat, z. B. „630 Minuten (10,5 Stunden)“) |
| Pause ≥ 0 und < Dauer | CHECK + Trigger → `23514` |
| Kein hartes Löschen | kein DELETE-Recht + Trigger → `42501`; Löschen = `deleted_at` setzen |
| Versionskonflikt | Trigger: gesendete `version` ≠ gespeicherte → `PT409`; sonst `version + 1` |
| Freigegebener Monat gesperrt | Trigger auf Zeiten und Zuweisungen → `PT423`; Änderung nur über `correct_time_entry` (Leitung, Begründung, Audit) |
| Unveränderliche Felder | `id`, `tenant_id`, `employee_id`, `created_*` bei Zeiten; `tenant_id`/`user_id` bei Mitarbeitern |

Die **detaillierte Pausenprüfung** (Schwellen 6 h/9 h, 15-Minuten-Abschnitte, Tagessumme) bleibt
in der App (`platform/src/core`) und liest die Schwellen aus `tenants.settings.breakPolicy`.
Die DB erzwingt nur die harten Grenzen oben und dass die Pausenregel des Mandanten nicht laxer
als § 4 ArbZG ist (Migration 0014, Details in [pausenregeln.md](pausenregeln.md)).

### Mandanteneinstellungen (`tenants.settings`)

```json
{
  "breakPolicy": { "thresholds": [{"minGrossMinutes": 360, "minPauseMinutes": 30},
                                  {"minGrossMinutes": 540, "minPauseMinutes": 45}],
                   "maxShiftMinutes": 720, "minPauseSegmentMinutes": 15 },
  "workAccount": { "enabled": true, "model": "school-year", "openingMinutes": -6000,
                   "federalState": "NW", "startMonth": "2026-09", "approvalRequired": true }
}
```

Das Beispiel entspricht den UWE-Regeln (strenge Pausenregel ab genau 6 h/9 h, Konto −100 h je
NRW-Schuljahr ab 09/2026); es gilt **nur** für den Mandanten, der es gespeichert hat. Neue Mandanten
erhalten neutrale Vorgaben (`private.default_tenant_settings()`: gesetzliche Pausenregel 361/541 Minuten
nach Wortlaut §4 ArbZG, max. 600 Minuten, Konto deaktiviert; Gegenstück in TypeScript:
`defaultBreakPolicy()`/`NEW_TENANT_BREAK_RULE`) – rechtlich *zu prüfen, keine Rechtsberatung*.
Die Pausenregel ist nie laxer als § 4 ArbZG (CHECK `tenants_break_policy_statutory`).

## Rollen der Datenbank

| Rolle | Zweck |
|---|---|
| `app_api` | LOGIN-Rolle der Node-API (Passwort/LOGIN setzt der Betrieb). NOINHERIT: ohne eigene Rechte, muss je Transaktion `set local role` ausführen. |
| `app_user` | Angemeldete Anfragen. Alle Tabellen unter RLS. |
| `app_anon` | Nicht angemeldete Anfragen: nur `public_tenant_branding()`. |
| `app_auth` | Anmeldung, Sitzungen, Passwort-Reset, Einladung annehmen. Kein Zugriff auf Fachdaten. |
| `app_service` | Wartung (Löschfristen, Exporte), BYPASSRLS. Nie für Anfragen verwenden. |

## RLS-Matrix (Rolle × Tabelle, Rolle `app_user`)

L = lesen, A = anlegen, Ä = ändern, – = kein Zugriff. „eigen“ = eigene Mitarbeiterzeile (aktiv).
Kein Zugriff auf andere Mandanten in keiner Zeile. DELETE gibt es für niemanden.
Alle Mandantenrollen gelten nur, solange der Mandant `status = 'active'` hat (seit 0008): Bei
`suspended`/`pending` sehen und ändern Mitarbeiter, Leitung und Inhaber nichts mehr – auch nicht die
eigene Mitarbeiterzeile. Plattformpersonal sieht weiterhin Metadaten (und mit aktiver Freigabe die Daten).
`current_session_context()` listet die Mitgliedschaft dann mit `tenantStatus`, damit die API „Firmenzugang gesperrt“ anzeigen kann.

| Tabelle | Mitarbeiter | Leitung (manager) | Inhaber (owner) | super_admin | support | Plattform mit aktiver Freigabe |
|---|---|---|---|---|---|---|
| tenants | L (eigener) | L | L, Ä (Profil, Branding, Kontakt, Einstellungen) | L alle, A, Ä | L alle | – zusätzlich |
| licenses | – | L | L | L, A, Ä | L | – |
| employees | L, Ä eigen (nur Name/E-Mail) | L, A, Ä (Rolle „employee“) | L, A, Ä (alle Rollen, nicht eigene Rolle) | – | – | L |
| platform_admins | – | – | – | L alle | L eigen | – |
| support_access_grants | – | L | L (+ RPC erteilen/widerrufen) | L | L | – |
| invitations | – | L (+ RPC) | L (+ RPC) | – | – | – |
| time_entries | L, A, Ä eigen | L, A, Ä Mandant | L, A, Ä Mandant | – | – | L |
| time_entry_revisions | L eigen | L | L | – | – | L |
| work_account_allocations | L, A, Ä eigen (Status bleibt `proposed`) | L, A, Ä (prüfen) | L, A, Ä | – | – | L |
| monthly_statements | L eigen (+ RPC einreichen) | L (+ RPC prüfen) | L (+ RPC, freigegebene wieder öffnen) | – | – | L |
| correction_requests | L eigen (+ RPC anlegen, zurückziehen) | L (+ RPC entscheiden, nicht die eigene) | L (+ RPC entscheiden, auch die eigene) | – | – | L |
| employee_status_history | L eigen | L | L | – | – | L |
| billing_settings | – | – | – | L (Änderung per RPC) | L | – |
| billing_periods | – | L | L | L (Änderung per RPC) | L | – |
| billing_period_lines | – | L | L | – | – | – |
| audit_log | – | L | L | L (Mandant/Lizenz/Freigabe/Abrechnungs-Ereignisse) | L (dto.) | L |
| auth.* | – | – | – | – | – | – |

Die Abrechnung (seit 0012) liefern SECURITY-DEFINER-Funktionen: `tenant_billing`/`tenant_billing_history`
(nur Leitung des Mandanten, mit Namen), `platform_billing_overview` (Plattformpersonal, nur Zahlen),
`platform_set_billing_status`/`platform_set_default_price` (nur Super-Admin, mit Audit). Regeln und
Berechnung: `private.billing_lines` und `private.billing_condition` (Monatsgrenzen Europe/Berlin), siehe
`docs/preismodell.md`.

Statuswechsel von Monatsabschlüssen, Prüfung von Zuweisungen, Einladungen, Support-Freigaben und
Korrekturen laufen ausschließlich über SECURITY-DEFINER-Funktionen mit expliziter Rechteprüfung
und `set search_path = ''`.

## Korrekturanfragen (0013)

| Funktion | Wer | Wirkung |
|---|---|---|
| `create_correction_request(employee_id, kind, entry_id, proposed, reason)` | nur für **eigene** Einträge (auch Leitung nur für sich selbst) | prüft Begründung (≥ 5 Zeichen), Werte (Datum, HH:MM, Beginn ≠ Ende, Mandantenhöchstdauer ≤ 12 h, Pause < Dauer), keine zweite offene Anfrage je Eintrag; speichert `before` aus dem aktuellen Eintrag; Audit `correction_request.create` |
| `withdraw_correction_request(id)` | nur die Person selbst, nur offen | Status `withdrawn`; Audit |
| `decide_correction_request(id, 'accepted' \| 'rejected', note)` | Leitung des Mandanten; die eigene Anfrage nur der Inhaber (Vier-Augen) | **Annehmen**: Eintrag unverändert seit der Anfrage (sonst `PT409`), dann `correct_time_entry` (Änderung/Löschung) bzw. Einfügen mit `source = 'correction'` und Kennung `kr-<Anfrage-ID>` (Nachtrag) – auch im gesperrten Monat; Revision mit `is_correction`, Begründung „Korrekturanfrage: … – Leitung: …“; Überschneidung `23P01`, 12 h `23514`. **Ablehnen**: Begründung ≥ 3 Zeichen Pflicht. Audit `correction_request.accept`/`.reject` |

Plattformpersonal sieht Anfragen (wie alle personenbezogenen Daten) nur mit aktiver Support-Freigabe und kann nicht entscheiden.

### Offene Entscheidung N1: Korrektur nach Freigabe

Eine Korrektur in einem **freigegebenen** Monat (direkt durch die Leitung oder über eine angenommene Anfrage) ändert die
Einträge, aber **nicht** die in `monthly_statements` gespeicherten Zahlen (`worked/allocated/billing_minutes` werden nur
beim Einreichen und Freigeben berechnet). Der freigegebene Nachweis zeigt damit den Stand zur Freigabe. Bewusst nicht
eigenmächtig geändert; stattdessen sichtbar gemacht: `statement_correction_flags` → Chef-Portal (Monatsnachweise,
Dashboard) „nach Freigabe korrigiert“ mit den aktuellen Werten, Mitarbeiter-App Hinweis in der Monatsansicht.
Möglichkeiten zur Entscheidung durch den Auftraggeber: (a) so lassen, der Inhaber gibt den Nachweis bei Bedarf zurück und
lässt neu einreichen (heute schon möglich), (b) Zahlen bei jeder Korrektur automatisch neu berechnen (Abrechnung kann sich
nachträglich ändern), (c) Korrektur im freigegebenen Monat nur nach Rückgabe erlauben.

## Datenschutz (0016)

| Objekt | Zweck |
|---|---|
| `tenants.retention_months_after_exit` (1–600 oder NULL) | Aufbewahrungsfrist nach dem Austritt, vom Inhaber festgelegt; NULL = keine Frist, keine Anonymisierung |
| `employees.anonymized_at` (+ Prüfregel `employees_anonymized_shape`) | Zeitpunkt der Anonymisierung; anonymisierte Zeilen sind über Anfragerollen nicht mehr änderbar (`employees_privacy_guard`) |
| `public.export_personal_data(employee_id) → jsonb` (definer) | Datenauskunft: die Person selbst (inkl. Konto, Sitzungen, 2FA-Status) oder der Inhaber (ohne Kontodaten); Audit `employee.data_export` |
| `public.export_tenant_data(tenant_id) → jsonb` (definer) | Gesamtexport für den Inhaber; Audit `tenant.data_export` |
| `public.anonymize_employee(employee_id, bestätigte_personalnummer) → employees` (definer) | Anonymisierung (Inhaber, deaktiviert, Frist abgelaufen ab Austritt laut `employee_status_history`, Personalnummer bestätigt); Fehler `55000` mit Fristende, `22023` falsche Nummer |
| `private.privacy_redactions` | transaktionsgebundene Freigabe (Schlüssel `txid`) für das Schwärzen in `audit_log`, `time_entry_revisions`, `correction_requests`, Prüfvermerken; keine Rechte für Anfragerollen. Die Schutz-Trigger (`private.audit_log_guard`, `private.revisions_guard`, Korrektur- und Zeiteintrags-Guards) erlauben unter dieser Freigabe nur Inhaltsfelder desselben Mandanten; DELETE bleibt verboten |
| `private.redact_personal(jsonb)` | ersetzt Namen, Adressen, Personalnummern, Bemerkungen und Begründungen rekursiv durch `[anonymisiert]` |

Tests: `tests/db/privacy.test.ts` (Rechte, Frist, Schwärzung, Unveränderlichkeit), `tests/server/privacy.test.ts`
(HTTP), `tests/db/security-catalog.test.ts` (Katalogprüfung aller Migrationen).

## Vertragsende (0020)

| Objekt | Zweck |
|---|---|
| `tenants.deleted_at` | gesetzt, wenn die Daten gelöscht sind und nur aufbewahrte Rechnungsunterlagen die Zeile noch brauchen (Platzhalter); Trigger `tenants_deleted_guard` (keine Änderung, keine Reaktivierung) und `employees_deleted_tenant_guard` (keine neuen Mitglieder) |
| `private.tenant_export_json(tenant_id)` | Inhalt des Gesamtexports; genutzt von `export_tenant_data` (Inhaber, aktiv) und `private.operator_export_tenant(slug)` (nur Eigentümerrolle, jeder Status, Audit `tenant.operator_export`) |
| `private.operator_delete_tenant(slug, bestätigung, export_sha256, ohne_export)` | Löschung eines deaktivierten Mandanten in einer Transaktion (Katalog-Durchlauf über alle Tabellen mit `tenant_id`, Prüfung am Ende); aufbewahrt: `invoices`, `billing_periods` ≠ `open`; Audit `tenant.deleted` ohne `tenant_id` und ohne Namen. Nur Eigentümerrolle |
| `private.tenant_deletions` | transaktionsgebundene Freigabe für DELETE in `audit_log` (Zeilen des Mandanten und mandantenlose Zeilen über gelöschte Konten), nur innerhalb der Löschfunktion |

Tests: `tests/db/tenant-offboarding.test.ts` (Rechte, Export, Vorbedingungen, Abbruch ohne Teil-Löschung,
Vollständigkeit über den Katalog, fremder Mandant unverändert, Platzhalter), `tests/server/tenant-offboarding-cli.test.ts`
(Befehle, Dateien, Prüfsumme).

## Tests

```sh
npx vitest run --project db
```

Ohne `DATABASE_URL` startet der Test einen Wegwerf-Cluster (`initdb`/`pg_ctl`, als Benutzer
`postgres`, wenn als root gestartet). Mit `DATABASE_URL` (CI: Service-Container `postgres:16`,
Superuser) wird je Testdatei eine neue Datenbank angelegt und wieder gelöscht.
