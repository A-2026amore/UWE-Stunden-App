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
| `0017_statement_reopen.sql` | Entscheidung N1 (28.10.2026): Monatsnachweis-Status `reopened`, `reopen_statement` (Leitung, Begründung Pflicht), keine Korrektur im **freigegebenen** Monat (auch nicht über `correct_time_entry` oder angenommene Korrekturanfragen → `PT423`), erneute Freigabe berechnet die Zahlen neu, Verlauf `monthly_statement_events` |
| `0018_tenant_status_billing.sql` | Statushistorie der Mandanten `tenant_status_history`; gesperrte/deaktivierte Firmen kosten ab dem Folgemonat 0 € (Kondition `tenant_suspended`/`tenant_deactivated`) |
| `0019_invoices.sql` | Rechnungen: Absenderangaben (`invoice_settings`), lückenlose Nummern je Jahr (`invoice_number_counters`, `SW-2026-000001`), unveränderliche Rechnungen und Stornorechnungen (`invoices`) |

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
| `tenants` | Mandant. `slug` eindeutig, `status` active/suspended/pending/deactivated (nur `active` gibt Mitgliedern Zugriff; `deactivated` seit 0015), `is_demo`. `branding`, `contact`, `settings` als jsonb mit Prüffunktion (Farben `#RRGGBB`; Bild-URLs nur `https://`, relativer Pfad ohne `//`/`..` oder `data:image/png|jpeg|webp;base64` – **kein SVG** seit 0008; WhatsApp nur Ziffern mit Ländervorwahl). Bereits gespeicherte SVG-Data-URLs (vor 0008) werden erst beim nächsten Ändern des Brandings abgelehnt. `legacy_import_enabled` (seit 0024, Standard `false`): Mitarbeiter-App bietet die Übernahme aus der alten UWE-App an; ändert nur der Super-Admin über `platform_set_legacy_import` (Grund Pflicht, Audit), Trigger `tenants_legacy_import_guard`. Bei Einführung für Nicht-Demo-Mandanten mit dem Wort „UWE“ im Namen eingeschaltet. |
| `licenses` | Tarif `pilot_free/standard/business/enterprise`, `status`, `price_cents` (veraltet, immer 0, ohne Wirkung), `billing none/manual/provider`, `valid_until` NULL = unbegrenzt. CHECK: `pilot_free` ⇒ `price_cents = 0` und `billing = 'none'`. Keine automatische Umstellung (kein Trigger/Job ändert den Tarif). Seit 0012 Sonderkondition: `employee_price_cents` (NULL = Standardpreis, 0–100000), `free_of_charge`, `condition_note`, `condition_valid_from/until` (gilt für jeden berührten Monat). Trigger: `pilot_free` ⇒ `free_of_charge = true` (CHECK); Wechsel weg von `pilot_free` setzt `free_of_charge` zurück, wenn es nicht ausdrücklich mitgeändert wird. |
| `employees` | Mitgliedschaft einer Person in einem Mandanten: `role` employee/manager/owner, `status` invited/active/locked/deactivated (`locked` = vorübergehend gesperrt, seit 0012), `personnel_number` eindeutig je Mandant, `user_id` → `auth.users` (erst nach Annahme der Einladung). `email` ist änderbar, solange kein Konto verknüpft ist; danach gesperrt (Anmelde-Adresse liegt in `auth.users`, siehe `docs/security.md`). |
| `platform_admins` | Plattformpersonal `super_admin` / `support`. Nur per Wartungszugang pflegbar. |
| `support_access_grants` | Vom Inhaber erteilte, befristete Freigabe (max. 30 Tage, per RPC max. 168 h) für Plattformpersonal; optional an eine Person gebunden; widerrufbar. |
| `invitations` | Einladung je Mitarbeiter (Ablauf, angenommen, widerrufen). Der Token liegt nur gehasht in `auth.one_time_tokens`. |
| `time_entries` | Einsatz. Schlüssel **`(tenant_id, employee_id, id)`**: `id` ist die vom Client erzeugte Kennung (`^[A-Za-z0-9_-]{4,100}$`, UUID oder migrierte `legacy-…`-Kennung) und nur **je Mitarbeiter** eindeutig = Idempotenzschlüssel. `version` (optimistische Sperre), `deleted_at` (Soft-Delete), `source` app/migration/correction. Berechnet: `duration_minutes`, `period` (tsrange; Ende ≤ Beginn ⇒ Ende am Folgetag). |
| `time_entry_revisions` | Vollständige Historie: je Insert/Update ein Schnappschuss (per Trigger), mit `operation` insert/update/delete/restore, `is_correction`, `reason`, `changed_by`. Unveränderlich. |
| `work_account_allocations` | Zuweisung ins Arbeitszeitkonto je Mitarbeiter und Monat (`YYYY-MM`), `minutes ≥ 0`, `status` proposed/approved/rejected (Ablehnung braucht Begründung). Nur wenn `settings.workAccount.enabled` und Monat ≥ `startMonth`. Migrierte Zuweisungen kommen mit `proposed`. |
| `employment_contracts` | Vertragsdaten je Mitarbeiter (seit 0025): `valid_from` (`YYYY-MM`, eindeutig je Mitarbeiter = Version ab diesem Monat), `employment_type` minijob/teilzeit/vollzeit/offen, `hourly_wage_cents` (NULL oder 1–100000), `monthly_target_minutes` (NULL = offen, sonst 1–24000), `carry_over_minutes` (einmaliger Übertrag im Startmonat, ±120000). Lesen: die Person selbst und Leitung (Support nur mit Freigabe). Schreiben nur über `set_employment_contract` / `delete_employment_contract`: Leitung; Leitungspersonen und die eigenen Daten nur der Inhaber; anonymisierte Datensätze nicht. Audit `employment_contract.*`; im Datenexport als `employmentContracts`. Berechnung Soll/Ist und Konto im Client (`platform/src/core/employment.ts`). |
| `monthly_statements` | Monatsabschluss draft/submitted/approved/returned/reopened (`reopened` seit 0017); Zahlen (`worked/allocated/billing_minutes`) berechnet die DB beim Einreichen und bei jeder (erneuten) Freigabe. `returned` ⇒ `review_note` Pflicht; `reopened` ⇒ Begründung (≥ 5 Zeichen) in `review_note` und `reopened_at` (CHECK). |
| `monthly_statement_events` | Seit 0017. Verlauf je Monatsnachweis: `action` submit/approve/return/reopen, Zeitpunkt, `actor_id`, Begründung, Zahlen zu diesem Zeitpunkt. Per Trigger geschrieben, beim Einspielen aus dem Audit-Log befüllt; nur Anfügen (Ausnahme: Schwärzen der Begründung bei Anonymisierung, 0016). |
| `tenant_status_history` | Seit 0018. Zeiträume `[valid_from, valid_to)` des Mandantenstatus mit Grund (`app.change_reason`) und `changed_by`; per Trigger auf `tenants.status`; Bestand aus dem Audit-Log rekonstruiert. Grundlage für „gesperrt ab Folgemonat = 0 €“. |
| `invoice_settings` | Seit 0019. Genau eine Zeile: Absender nach § 14 UStG (Name, Anschrift, Steuernummer oder USt-IdNr.), `vat_rate_percent` (Standard 19, `vat_rate_confirmed` = vom Auftraggeber bestätigt), `payment_terms_days` (Standard 14), Zahlungshinweis, `number_prefix` (Standard `SW`). Änderung nur über `platform_set_invoice_settings` (Super-Admin, Grund, Audit). |
| `invoice_number_counters` | Seit 0019. Zähler je Jahr; nur +1 (Trigger), kein Löschen. Wird in derselben Transaktion wie die Rechnung hochgezählt (Zeilensperre) → lückenlos, keine Nummer doppelt oder wiederverwendet. |
| `invoices` | Seit 0019. Rechnung (`kind = invoice`) oder Stornorechnung (`cancellation`, negative Beträge, `cancels_invoice_id`), mit `tenant_id`. Absender, Empfänger, Positionen, USt-Satz, Beträge, Rechnungs- und Fälligkeitsdatum sind eingefroren (Trigger `invoices_guard`); einzige Änderung: Storno-Vermerk am Original. Höchstens eine gültige Rechnung je Mandant und Monat. Kein Löschen. |
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
| Freigegebener Monat gesperrt | Trigger auf Zeiten und Zuweisungen → `PT423`, **für alle** (seit 0017 auch für `correct_time_entry` und angenommene Korrekturanfragen). Erst `reopen_statement` (Leitung, Begründung) öffnet den Monat für die Leitung; Mitarbeitende bleiben gesperrt und stellen Korrekturanfragen |
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
| monthly_statement_events | L eigen | L | L | – | – | L |
| tenant_status_history | – | L | L | L | L | – |
| invoice_settings | – | – | – | L (Änderung per RPC) | L | – |
| invoice_number_counters | – | – | – | – | – | – |
| invoices | – | – | L (eigene Firma) | L (A per RPC) | L | – |
| audit_log | – | L | L | L (Mandant/Lizenz/Freigabe/Abrechnungs-/Rechnungs-Ereignisse) | L (dto.) | L |
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

### Entschieden (N1, 28.10.2026): Korrektur nach Freigabe nur nach Wiederöffnung (0017)

Ein **freigegebener** Monat ist für alle gesperrt – auch für `correct_time_entry` und das Annehmen von Korrekturanfragen
(Trigger `time_entries_approved_guard` → `PT423`). Ablauf:

1. `reopen_statement(statement_id, reason)` – Leitung des Mandanten (den eigenen Nachweis nur der Inhaber), Begründung
   ≥ 5 Zeichen, nur aus `approved`. Status `reopened`, Audit `statement.reopen`, Eintrag im Verlauf.
2. Im wieder geöffneten Monat korrigiert die Leitung direkt (Begründung → Revision mit `is_correction`, Audit) oder nimmt
   Korrekturanfragen an; sie kann die Kontoaufteilung prüfen. Mitarbeitende ändern selbst nichts (Korrekturanfrage).
3. `approve_statement` (erneute Freigabe direkt aus `reopened`) oder `return_statement` → Mitarbeitende ändern und reichen
   neu ein. Bei jeder Freigabe werden die Zahlen neu berechnet und gespeichert; der Verlauf behält die alten Zahlen.

`return_statement` öffnet einen freigegebenen Monat nicht mehr (`55000`). Die Sicht `statement_correction_flags`
(„nach Freigabe korrigiert“) bleibt nur für Altfälle vor 0017; neue Fälle entstehen nicht mehr.
**Abrechnung:** Eine Wiederöffnung ändert keinen festgeschriebenen Abrechnungsmonat (`billing_periods`) und keine
Rechnung – berechnet werden Personen, nicht Stunden.

| Funktion | Wer | Wirkung |
|---|---|---|
| `reopen_statement(id, reason)` | Leitung; eigener Nachweis nur Inhaber; Mandant aktiv | `approved` → `reopened`; `22023` ohne Begründung, `55000` falscher Status |
| `approve_statement(id)` | Leitung (nicht der eigene, außer Inhaber) | aus `submitted` oder `reopened`; Zahlen neu |
| `return_statement(id, note)` | Leitung | aus `submitted` oder `reopened` |
| `submit_statement(employee_id, month)` | Person selbst | auch aus `reopened` (erneutes Einreichen) |

## Gesperrte Firmen in der Abrechnung (0018)

`private.tenant_block(tenant, month)` liefert Status, Zeitpunkt und Grund, wenn der Mandant während des **ganzen**
Monats (Europe/Berlin) `suspended` oder `deactivated` war. `private.billing_condition` gibt dann 0 € mit der Kondition
`tenant_suspended`/`tenant_deactivated` zurück (vor allen anderen Regeln). Beispiel: gesperrt am 10.11. → November
wird berechnet, ab Dezember 0 €. Reaktivierung im Monat → dieser Monat wird wieder berechnet. `pending` zählt nicht als
Sperre. `tenant_billing` zeigt dem Kunden `tenantBlock` (Status, seit) **ohne** Grund; `platform_billing_overview`
liefert Plattformpersonal zusätzlich `block_since` und `block_reason`. Festgeschriebene Monate behalten ihre Kondition.

## Rechnungen (0019)

| Funktion | Wer | Wirkung |
|---|---|---|
| `platform_invoice_settings()` | Plattformpersonal | Absenderangaben + `missing` (fehlende Pflichtangaben, deutsch) |
| `platform_set_invoice_settings(jsonb, reason)` | Super-Admin | ändert die Angaben; Audit `invoice_settings.update` |
| `platform_invoice_draft(tenant, month)` | Plattformpersonal | Entwurf ohne Nummer (Wasserzeichen „Entwurf – Pflichtangaben fehlen“, wenn etwas fehlt) |
| `platform_issue_invoice(tenant, month)` | Super-Admin | Nummer `SW-JJJJ-000001` (Zähler je Jahr, gesperrt, lückenlos), friert Daten ein; verweigert bei fehlenden Pflichtangaben, bestehender Rechnung, erlassenem Monat, 0 € und laufendem Monat; ein offener Monat wird als `invoiced` festgeschrieben; Audit `invoice.issue` |
| `platform_cancel_invoice(id, reason)` | Super-Admin | Stornorechnung mit eigener Nummer und negativen Beträgen; Original bleibt, wird als storniert markiert; Audit `invoice.cancel` |

Rechnungen enthalten keine Namen von Mitarbeitenden (nur Anzahl × Preis). Kein Versand, keine Zahlungsabwicklung.
Kunden (Inhaber) lesen ihre eigenen Rechnungen (RLS `is_owner`), Plattformpersonal alle.
Hinweis für die Mandantenlöschung: `invoices` trägt `tenant_id`, ist aber unveränderlich und ohne `on delete cascade`
(Aufbewahrungspflicht für Rechnungen, § 14b UStG / § 147 AO) – vor einer Löschung fachlich zu klären.

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

## Rechnung schützt den Abrechnungsmonat (0021)

Trigger `billing_periods_invoice_guard`: Solange für Mandant und Monat eine gültige (nicht stornierte) Rechnung
besteht, lehnt die Datenbank den Wechsel des Abrechnungsmonats auf `open` oder `waived` ab (Fehler 55000 mit
Rechnungsnummer). `invoiced` → `paid` bleibt möglich. Korrekturweg: Rechnung stornieren (0019), danach Monat
wieder öffnen oder erlassen.

## Bruttopreise und Aktionscodes (0022)

- `billing_settings.default_price_cents` und `licenses.employee_price_cents` sind **Bruttopreise** (inkl. USt.).
  `private.invoice_build` rechnet die enthaltene USt. heraus: `vat = round(brutto × Satz / (100 + Satz))`,
  `net = brutto − vat`. Gespeicherte Rechnungen bleiben unverändert.
- `promo_codes` (Code `^[A-Z0-9-]{6,32}$`, Nachlass 1–100 %, optional `max_redemptions`, `redeemable_until`,
  Ende mit Grund) und `promo_redemptions` (je Firma höchstens ein laufender Rabatt, je Code und Firma eine
  Einlösung, Nachlass wird beim Einlösen kopiert). Beide Tabellen ohne Rechte für `app_user`; Zugriff nur über
  die SECURITY-DEFINER-Funktionen `platform_promo_codes`, `platform_create_promo_code`, `platform_end_promo_code`,
  `platform_end_promo_redemption`, `tenant_promo`, `tenant_redeem_promo_code` (alle protokolliert).
- `private.promo_for(tenant, month)`: Einlösung, deren Laufzeit den Monat berührt (mehrere: höchster Nachlass).
  `private.billing_condition` wendet den Nachlass auf Standard- oder Sonderpreis an (Kondition `promo`);
  Sperre, Pilot und kostenloses Konto bleiben 0 €. `tenant_billing` liefert `promo`, `platform_billing_overview`
  `promo_code`/`promo_discount_percent`. Tests: `tests/db/promo-codes.test.ts`.

## Tarif: Testphase, 12-Monats-Abo, Monatstarif, Vertragsschluss, Monatsrechnungen (0023)

Regeln wie `platform/src/core/subscription.ts` und `billingConditionFor` (`platform/src/core/billing.ts`); Tage in
Europe/Berlin (`private.berlin_today()`).

- `billing_settings`: zusätzlich `monthly_price_cents` (650 = 6,50 € brutto; `default_price_cents` = 12-Monats-Abo),
  `trial_window_from`/`trial_window_until` (beide leer = kein Einführungsangebot), `trial_months` (3),
  `cancel_notice_days` (0), `welcome_promo_code_id`.
- `tenant_subscriptions.trial_ends_on`: beim Anlegen der Firma festgelegt – Gründungstag im Fenster → Ende des
  Kalendermonats, in dem `trial_months` Monate enden (15.11. + 3 Monate → 28.02.). Abgerechnet wird ab dem Folgemonat.
- `subscription_terms`: Laufzeiten vom 1. bis zu einem Monatsletzten, `monthly` oder `annual`; `ends_on` leer = läuft
  weiter, `starts_on − 1` = lief nie. Überschneidungsfrei (Exclusion-Constraint). 12-Monats-Abo: 12 Monate, dann
  je +6 Monate (berechnet: Ende k = Start + (12 + 6k) Monate − 1 Tag), solange nicht bis Laufzeitende −
  `cancel_notice_days` gekündigt. Trigger beim Anlegen einer Firma: Monatstarif ab dem ersten zahlpflichtigen Monat;
  wird `tenants.created_at` korrigiert (Seed), folgen Testphase und Start, solange nur diese automatische Laufzeit besteht.
- Bestandsfirmen (vor 0023): `tenant_subscriptions.terms_from` = Monatserster nach der Migration (Berlin), die
  Monatstarif-Laufzeit beginnt dort. Monate davor rechnen nach der bisherigen Regel (Standardpreis, keine Laufzeit
  nötig) – kein rückwirkender Monatstarif. Neue Firmen: `terms_from` leer. Die Seed-Firmen werden wie Bestandsfirmen behandelt.
- `private.billing_condition`: Sperre → Pilot → kostenlos → (vor `terms_from`: bisherige Regel) → `trial` → keine Laufzeit `ended` (0 €) → Sonderpreis →
  `standard` (12-Monats-Abo) / `monthly` → Aktionsrabatt. Eingefrorene Monate und ausgestellte Rechnungen bleiben
  unverändert; Änderungen am Tarif wirken nur ab dem laufenden bzw. nächsten Monat. Rechnungszeile nennt
  „12-Monats-Abo“ bzw. „Monatstarif“.
- `tenant_contracts`: Vertragsschluss durch den Inhaber (Zeitpunkt, Benutzer, AGB-/AVV-Version, Tarif), einmalig.
  Bestehende Firmen und Seed-/Testumgebungsfirmen: `bestand`/`testumgebung`. Trigger `private.contract_guard` auf
  `time_entries`, `employees`, `invitations`: Mitglieder der Firma können vor dem Vertragsschluss nichts anlegen
  (55000); Plattform, Operator-CLI und Wartung (kein Mitglied) sind nicht betroffen.
- Kündigung eines geplanten, noch nicht begonnenen Wechsels (ohne „danach monatlich“): der Wechsel wird
  zurückgenommen, die ersetzte Laufzeit läuft weiter (Audit `subscription.cancel` mit `undoneSwitch`).
  `TenantSubscription.withdrawable`: die Kündigung, die „zurücknehmen“ aufheben würde.
- Willkommenscode: ein neu gesetzter Code muss aktiv sein; der unveränderte gespeicherte Code darf inzwischen beendet sein.
- `subscription_reminders`: je Firma, Art (`trial_end`, `annual_renewal`) und Stichtag genau eine Erinnerung;
  `auth.claim_subscription_reminders(p_today)` (Rollen `app_auth`, `app_service`). Testphase: nur mit
  Vertragsschluss und einer (nicht gekündigten) Laufzeit nach der Testphase. Verlängerung: von
  `add_months(Ende − Frist, −1)` bis `Ende − Frist`. Empfänger: aktive Inhaber (`private.owner_emails`, Konto-Adresse,
  sonst Adresse im Personaldatensatz) – auch für die Kündigungsbestätigung (`tenant_subscription_mail_recipients`).
- `p_today` (abweichender Stichtag) nur aus der Wartung (Rolle `app_service`) bzw. als Eigentümer ohne Rollenwechsel;
  der Server-Job (`app_auth`) arbeitet immer mit heute (sonst 42501).
- Monatsrechnungen: `private.set_billing_status` und `private.issue_invoice` enthalten den unveränderten Ablauf von
  `platform_set_billing_status`/`platform_issue_invoice` (die öffentlichen Funktionen prüfen den Super-Admin und rufen
  sie auf). `auth.issue_monthly_invoices(p_today)` (Rollen `app_auth`, `app_service`) erzeugt ab dem 2. die Rechnungen
  des Vormonats (Betrag > 0, keine Demo, noch keine – auch keine stornierte – Rechnung, nicht erlassen); Probleme einer
  Firma halten die anderen nicht auf. Audit `invoice.issue` mit `issuedBy: "system"`, ohne `actor_id`.
- Funktionen (SECURITY DEFINER, `search_path = ''`, protokolliert): `tenant_subscription`, `tenant_accept_contract`,
  `tenant_choose_subscription`, `tenant_cancel_subscription`, `tenant_withdraw_cancellation`, `platform_billing_settings`,
  `platform_update_billing_settings`, `platform_welcome_promo_code`. Die Tabellen haben keine Rechte für `app_user`.
  Audit-Entität `subscription` ist für die Plattform sichtbar.
- Behoben: `invoice_build` meldete eine fehlende Kundenanschrift mit `text[] || 'Text'` (Fehler „malformed array
  literal“); seit 0023 `array_append`.
- Tests: `tests/db/subscriptions.test.ts` (Vergleich mit den Core-Regeln), `tests/server/subscription.test.ts`.
