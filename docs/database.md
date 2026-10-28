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

public.tenants ─┬─< licenses            (max. 1 aktive je Mandant)
                ├─< support_access_grants
                └─< employees ─┬─< invitations
                               ├─< time_entries ─< time_entry_revisions
                               ├─< work_account_allocations
                               └─< monthly_statements
public.audit_log   (tenant_id ohne FK – bleibt erhalten)
```

Alle mandantenbezogenen Kindtabellen referenzieren `(employee_id, tenant_id)` → `employees(id, tenant_id)`.
Dadurch kann `tenant_id` nie von der des Mitarbeiters abweichen (keine „gefälschte“ Mandanten-ID).

## Tabellen

| Tabelle | Zweck / wichtige Regeln |
|---|---|
| `tenants` | Mandant. `slug` eindeutig, `status` active/suspended/pending (nur `active` gibt Mitgliedern Zugriff), `is_demo`. `branding`, `contact`, `settings` als jsonb mit Prüffunktion (Farben `#RRGGBB`; Bild-URLs nur `https://`, relativer Pfad ohne `//`/`..` oder `data:image/png|jpeg|webp;base64` – **kein SVG** seit 0008; WhatsApp nur Ziffern mit Ländervorwahl). Bereits gespeicherte SVG-Data-URLs (vor 0008) werden erst beim nächsten Ändern des Brandings abgelehnt. |
| `licenses` | Tarif `pilot_free/standard/business/enterprise`, `status`, `price_cents`, `billing none/manual/provider`, `valid_until` NULL = unbegrenzt. CHECK: `pilot_free` ⇒ `price_cents = 0` und `billing = 'none'`. Keine automatische Umstellung (kein Trigger/Job ändert den Tarif). |
| `employees` | Mitgliedschaft einer Person in einem Mandanten: `role` employee/manager/owner, `status` invited/active/deactivated, `personnel_number` eindeutig je Mandant, `user_id` → `auth.users` (erst nach Annahme der Einladung). `email` ist änderbar, solange kein Konto verknüpft ist; danach gesperrt (Anmelde-Adresse liegt in `auth.users`, siehe `docs/security.md`). |
| `platform_admins` | Plattformpersonal `super_admin` / `support`. Nur per Wartungszugang pflegbar. |
| `support_access_grants` | Vom Inhaber erteilte, befristete Freigabe (max. 30 Tage, per RPC max. 168 h) für Plattformpersonal; optional an eine Person gebunden; widerrufbar. |
| `invitations` | Einladung je Mitarbeiter (Ablauf, angenommen, widerrufen). Der Token liegt nur gehasht in `auth.one_time_tokens`. |
| `time_entries` | Einsatz. Schlüssel **`(tenant_id, employee_id, id)`**: `id` ist die vom Client erzeugte Kennung (`^[A-Za-z0-9_-]{4,100}$`, UUID oder migrierte `legacy-…`-Kennung) und nur **je Mitarbeiter** eindeutig = Idempotenzschlüssel. `version` (optimistische Sperre), `deleted_at` (Soft-Delete), `source` app/migration/correction. Berechnet: `duration_minutes`, `period` (tsrange; Ende ≤ Beginn ⇒ Ende am Folgetag). |
| `time_entry_revisions` | Vollständige Historie: je Insert/Update ein Schnappschuss (per Trigger), mit `operation` insert/update/delete/restore, `is_correction`, `reason`, `changed_by`. Unveränderlich. |
| `work_account_allocations` | Zuweisung ins Arbeitszeitkonto je Mitarbeiter und Monat (`YYYY-MM`), `minutes ≥ 0`, `status` proposed/approved/rejected (Ablehnung braucht Begründung). Nur wenn `settings.workAccount.enabled` und Monat ≥ `startMonth`. Migrierte Zuweisungen kommen mit `proposed`. |
| `monthly_statements` | Monatsabschluss draft/submitted/approved/returned; Zahlen (`worked/allocated/billing_minutes`) berechnet die DB. `returned` ⇒ `review_note` Pflicht (CHECK). |
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
Die DB erzwingt nur die harten Grenzen oben.

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

Das Beispiel entspricht den UWE-Regeln (ab genau 6 h/9 h, Konto −100 h je NRW-Schuljahr ab 09/2026);
es gilt **nur** für den Mandanten, der es gespeichert hat. Neue Mandanten erhalten neutrale
Vorgaben (`private.default_tenant_settings()`: 361/541 Minuten nach Wortlaut §4 ArbZG, max. 600 Minuten,
Konto deaktiviert) – rechtlich *zu prüfen, keine Rechtsberatung*.

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
| audit_log | – | L | L | L (Mandant/Lizenz/Freigabe-Ereignisse) | L (dto.) | L |
| auth.* | – | – | – | – | – | – |

Statuswechsel von Monatsabschlüssen, Prüfung von Zuweisungen, Einladungen, Support-Freigaben und
Korrekturen laufen ausschließlich über SECURITY-DEFINER-Funktionen mit expliziter Rechteprüfung
und `set search_path = ''`.

## Tests

```sh
npx vitest run --project db
```

Ohne `DATABASE_URL` startet der Test einen Wegwerf-Cluster (`initdb`/`pg_ctl`, als Benutzer
`postgres`, wenn als root gestartet). Mit `DATABASE_URL` (CI: Service-Container `postgres:16`,
Superuser) wird je Testdatei eine neue Datenbank angelegt und wieder gelöscht.
