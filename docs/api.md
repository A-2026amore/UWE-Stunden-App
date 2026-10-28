# Datenbank-Schnittstelle für die Node-API

Die eigene Node-API (eigener Server, kein Supabase/PostgREST) verbindet sich mit der Login-Rolle
`app_api` (Bibliothek `pg`) und führt **jede Anfrage in einer eigenen Transaktion** aus:

```ts
const client = await pool.connect();
try {
  await client.query("begin");
  await client.query("set local role app_user");                    // angemeldet
  await client.query("select set_config('request.jwt.claims', $1, true)",
                     [JSON.stringify({ sub: session.userId })]);   // aus geprüfter Sitzung
  const { rows } = await client.query(
    "select * from public.update_time_entry($1, $2, $3, $4, $5)",
    [employeeId, entryId, { end: "16:00", pauseMinutes: 30 }, expectedVersion, null]);
  await client.query("commit");
} catch (e) {
  await client.query("rollback");
  throw mapPgError(e);
} finally {
  client.release();
}
```

- Nicht angemeldet: `set local role app_anon`. Anmeldung/Sitzungen: `set local role app_auth`.
- `set local` gilt nur bis Transaktionsende – wichtig wegen Connection-Pooling.
- Lesende Zugriffe dürfen direkt per SQL auf die Tabellen gehen (RLS filtert), z. B.
  `select * from public.time_entries where employee_id = $1 and work_date between $2 and $3 and deleted_at is null`.
- Schreibzugriffe bevorzugt über die Funktionen unten (Konfliktprüfung, Begründungen, Audit).

## Fehlercodes → HTTP

| SQLSTATE | Bedeutung | HTTP / Repository |
|---|---|---|
| `42501` | kein Recht / RLS / nicht gefunden | 403 → `AccessDeniedError` |
| `PT409` | Versionskonflikt | 409 → `ConflictError` |
| `PT423` | Monat freigegeben/gesperrt | 423 |
| `23P01` | Überschneidung mit anderem Einsatz | 409 („Einsätze überschneiden sich“) |
| `23514`, `22023`, `22007`, `22008` | ungültige Eingabe (Dauer, Pause, Begründung, Datum/Uhrzeit) | 400 |
| `23505` | Eindeutigkeit (z. B. Personalnummer) | 409 |
| `55000` | Statusübergang nicht erlaubt | 409 |

Fehlertexte der Funktionen sind deutsch und können angezeigt werden; Texte von
Constraint-Fehlern (`23P01`, `23505`, `23514` aus CHECK) sollte die API auf eigene deutsche Texte abbilden.

## Funktionen (Rolle `app_user`)

Patch-/Eingabeobjekte verwenden die camelCase-Schlüssel aus `platform/src/data/repository.ts`.
Unbekannte Schlüssel werden abgelehnt (`22023`). Zeiteinträge werden immer über
**Mitarbeiter-ID + Client-ID** adressiert (die Client-ID ist nur je Mitarbeiter eindeutig).

| Funktion | Sicherheit | Repository-Methode |
|---|---|---|
| `current_session_context() → jsonb` `{userId, memberships[{tenantId, employeeId, role, tenantName}], platformRole}` | invoker | `currentSession` |
| `create_time_entry(employee_id, {id, date, start, end, pauseMinutes, note, source?}) → time_entries` – idempotent je Mitarbeiter | invoker | `createTimeEntry` |
| `update_time_entry(employee_id, id, patch, expected_version, reason?) → time_entries` | invoker | `updateTimeEntry` |
| `delete_time_entry(employee_id, id, expected_version, reason?) → time_entries` (Soft-Delete) | invoker | `deleteTimeEntry` |
| `correct_time_entry(employee_id, id, patch(+deleted), expected_version, reason)` – Leitung, auch gesperrte Monate, Begründung ≥ 5 Zeichen | definer | Korrektur im Chef-Portal |
| `set_allocation(employee_id, month, minutes) → work_account_allocations` (Status `proposed`) | invoker | `setAllocation` |
| `review_allocation(employee_id, month, 'approved'/'rejected', reason?)` – Ablehnung mit Begründung | definer | `reviewAllocation` |
| `submit_statement(employee_id, month)` | definer | `submitStatement` |
| `approve_statement(statement_id)` | definer | `approveStatement` |
| `return_statement(statement_id, reason)` – Begründung Pflicht; freigegebene nur Inhaber | definer | `returnStatement` |
| `set_employee_status(employee_id, 'active'/'locked'/'deactivated', reason)` – `locked` nur aus `active` (sonst `55000`); `active` entsperrt/reaktiviert | invoker | `setEmployeeStatus` |
| `create_invitation(employee_id, valid_days=7) → {invitationId, token, expiresAt}` | definer | `inviteEmployee` (nach Insert in `employees`) |
| `create_correction_request(employee_id, kind, entry_id, proposed, reason) → correction_requests` – nur eigene Einträge | definer | `createCorrectionRequest` |
| `withdraw_correction_request(id)` – eigene offene Anfrage | definer | `withdrawCorrectionRequest` |
| `decide_correction_request(id, 'accepted'/'rejected', note?)` – Leitung, Vier-Augen; Annehmen wendet die Korrektur an | definer | `decideCorrectionRequest` |
| `grant_support_access(tenant_id, hours, reason, grantee?)`, `revoke_support_access(grant_id)` | definer | Inhaber-Einstellungen |
| `platform_list_tenants()` – nur Metadaten und Zahlen | definer | `listTenants` |
| `create_tenant(name, slug, plan, is_demo, owner_email, owner_name?, contact?) → {tenantId, licenseId, ownerEmployeeId, invitationToken}` | definer | `createTenant` |
| `set_tenant_status(tenant_id, status, reason)` | definer (seit 0011) | `setTenantStatus` |
| `tenant_billing(tenant_id, month) → jsonb` `{tenantId, month, isCurrentMonth, status, final, condition, plan, unitPriceCents, billableCount, amountCents, currency, closedAt, lines[{employeeId, displayName, personnelNumber, role, status, reason}]}` – nur Leitung des Mandanten; künftige Monate `22023` | definer (0012) | `getTenantBilling` |
| `tenant_billing_history(tenant_id, limit=12) → (month, status, final, condition, unit_price_cents, billable_count, amount_cents)` – ab laufendem Monat rückwärts, nicht vor Anlage des Mandanten | definer (0012) | `listTenantBillingHistory` |
| `platform_billing_overview(month)` – je Mandant nur Zahlen (keine Namen) | definer (0012) | `getPlatformRevenue` |
| `platform_set_billing_status(tenant_id, month, 'open'/'invoiced'/'paid'/'waived', note?)` – nur vergangene Monate (`55000`), Verlassen von `open` schreibt fest, `waived` und Wiederöffnen brauchen eine Begründung, Audit | definer (0012) | `setBillingStatus` |
| `platform_set_default_price(cents, reason)` – nur Super-Admin, Audit | definer (0012) | `setDefaultPrice` |

Direkter Tabellenzugriff (unter RLS) für die übrigen Methoden, z. B.
`getTenant` → `select … from tenants where id = $1`; `updateBranding/Contact/Settings` →
`update tenants set branding = branding || $2::jsonb where id = $1` (Validierung per CHECK);
`listEmployees`, `inviteEmployee` (Insert), `updateEmployee`, `listStatements`, `getStatement`,
`listAudit`, `setLicense` (`insert`/`update licenses`, nur super_admin).

Ohne Anmeldung (`app_anon`): `public_tenant_branding(slug) → (slug, name, branding)` für die Login-Seite.

## Anmeldung (Rolle `app_auth`)

| Funktion | Zweck |
|---|---|
| `auth.get_login(email) → (user_id, password_hash)` | Hash holen; Prüfung mit `crypto.scrypt` + `timingSafeEqual` in der API |
| `auth.create_session(user_id, ttl='12 hours', user_agent?) → (session_id, token, expires_at)` | Token einmalig als HttpOnly-Cookie setzen |
| `auth.resolve_session(token, idle_minutes=120) → (session_id, user_id, expires_at)` | je Anfrage; prüft Ablauf, gesperrte Konten und Leerlauf (widerruft leerlaufende Sitzungen), aktualisiert `last_seen_at`; leeres Ergebnis = abgemeldet (seit 0008) |
| `auth.revoke_session(token) → boolean` | Abmelden |
| `auth.create_password_reset(email) → token \| null` | Link per E-Mail; Antwort an den Client immer gleich |
| `auth.reset_password(token, password_hash) → user_id` | setzt Hash, beendet alle Sitzungen |
| `auth.invitation_needs_existing_login(token) → boolean` | Einladung gehört zu einer E-Mail mit bestehendem Konto (seit 0008) |
| `auth.accept_invitation(token, password_hash) → user_id` | neues Konto: Hash Pflicht; bestehendes Konto: Hash muss `NULL` sein (sonst `PT409`), Konto wird ohne Passwortänderung verknüpft; aktiviert Mitarbeiter |

| `auth.two_factor_requirement(user_id) → 'platform' \| 'tenant' \| null` | Pflicht zur Zwei-Faktor-Anmeldung: Plattformkonto bzw. Inhaber/Vorgesetzte eines aktiven Mandanten mit `require_two_factor_for_managers` (seit 0009) |
| `auth.two_factor_state(user_id) → (enrolled, required_by)` | je Anfrage zusammen mit `resolve_session` (seit 0009) |

Tabellen der Zwei-Faktor-Anmeldung (nur `app_auth`, seit 0009): `auth.totp_factors` (verschlüsseltes Geheimnis,
`enrolled_at`, `last_used_step`), `auth.totp_recovery_codes` (Hashes, `used_at`), `auth.two_factor_challenges`
(ausstehender zweiter Anmeldeschritt). Ver-/Entschlüsselung, Code-Prüfung und Hashing macht die API
(`server/src/twoFactor.ts`); Details in `docs/security.md` Abschnitt 4a.

Ablauf je Anfrage: Cookie → `resolve_session` (als `app_auth`) → `user_id` →
neue Transaktion als `app_user` mit `request.jwt.claims.sub = user_id`.

## HTTP-Schnittstelle der Node-API (`server/`)

Umsetzung: `server/src` (Start, Umgebungsvariablen und Betrieb: `server/README.md`),
Client: `platform/src/data/api.ts` (`createApiRepository(baseUrl)`).

**Allgemein**
- JSON, UTF-8. Fehler: `{"error": {"code": "...", "message": "<deutscher Text>"}}`.
- Sitzung per Cookie `__Host-sid` (HTTPS) bzw. `sid` (lokal http): `HttpOnly; SameSite=Strict; Path=/`,
  32 Byte Zufall, in `auth.sessions` nur als SHA-256-Hash. Ablauf 12 h, Leerlauf-Timeout 120 min.
  Prüfung je Anfrage mit `auth.resolve_session(token, SESSION_IDLE_MINUTES)` (als `app_auth`), danach in der
  `app_user`-Transaktion `current_session_context()`: Hat die Person keine Mitgliedschaft in einem
  **aktiven** Mandanten (und keine Plattformrolle), antwortet jede Anfrage mit 403
  `tenant_suspended` „Der Firmenzugang ist derzeit gesperrt. Bitte wende dich an deinen Arbeitgeber.“
  (deaktivierter Mandant: „Der Firmenzugang ist deaktiviert. Bitte wende dich an deinen Arbeitgeber.“)
  (bestehende Sitzungen enden damit sofort; `GET /api/auth/session` liefert `null`).
- POST/PUT/PATCH/DELETE: Pflicht `Content-Type: application/json` (sonst 415) und `Origin` aus
  `PUBLIC_ORIGIN` (sonst 403). Body-Limit 32 KB (Branding 1,2 MB).
- Statuscodes zusätzlich zur Tabelle oben: 401 nicht angemeldet, 413 zu groß, 415 kein JSON,
  429 Rate-Limit (mit `Retry-After`), 400 `break_rule` (Pausenregel), 409 `ambiguous`
  (Eintrags-ID ohne Mitarbeiter nicht eindeutig).
- Leere Treffer bei fremden Daten werden als **403** beantwortet (Vorprüfung mit denselben
  `private.*`-Funktionen wie die RLS-Richtlinien).

**Anmeldung**

| Methode, Pfad | Body | Antwort |
|---|---|---|
| `POST /api/auth/login` | `{email, password}` | 200 `Session` + Cookie · mit eingerichteter 2FA stattdessen 200 `{twoFactorRequired: true}` + Cookie `__Host-tfa` (keine Sitzung) · 401 einheitlicher Text · gesperrter Zugang ohne 2FA: dieselbe 401 wie bei falschem Passwort; mit 2FA Challenge wie üblich, 403 `tenant_suspended`/`forbidden` erst bei `2fa/verify` · 429 |
| `POST /api/auth/logout` | `{}` | 204, Cookies (Sitzung, ausstehender 2FA-Schritt) gelöscht, Sitzung widerrufen |
| `GET /api/auth/session` | – | 200 `Session` oder `null` (Session enthält zusätzlich `memberships`) |
| `POST /api/auth/password-reset` | `{email}` | immer 204 (keine Kontenaufzählung); Link `PUBLIC_ORIGIN + RESET_LINK_PATH#token=…` |
| `POST /api/auth/password-reset/confirm` | `{token, password}` | 204 · 400 Link ungültig/Passwort zu kurz (min. 10 Zeichen) |
| `POST /api/auth/invitation/accept` | `{token, password?}` | 200 `{existingAccount, message}`, keine automatische Anmeldung. Erst `invitation_needs_existing_login`: bestehendes Konto → Verknüpfung **ohne** Passwort (ein mitgesendetes Passwort wird nicht verwendet), `message` bittet um Anmeldung mit dem bisherigen Passwort; neues Konto → `password` Pflicht (min. 10 Zeichen). `PT409` → 409 `existing_account` |
| `GET /api/public/tenants/:slug/branding` | – | Login-Seite (`app_anon`) |

**Zwei-Faktor-Anmeldung (TOTP)**

Ablauf mit eingerichteter 2FA: `POST /api/auth/login` (Passwort) → Cookie `__Host-tfa` (lokal http: `tfa`;
`HttpOnly; SameSite=Strict; Path=/; Max-Age=300`) → `POST /api/auth/2fa/verify` → Sitzungs-Cookie.
Nachweis (`proof`) ist **genau eines** von `{code: "123456"}` (6 Ziffern, Leerzeichen erlaubt) oder
`{recoveryCode: "ABCD-EFGH-JKMN-PQRS"}` (Groß-/Kleinschreibung und Bindestriche egal).

| Methode, Pfad | Body | Antwort |
|---|---|---|
| `POST /api/auth/2fa/verify` | `proof` | 200 `Session` (+ `recoveryCodesRemaining`, wenn ein Wiederherstellungscode benutzt wurde), Cookie `__Host-tfa` gelöscht · 401 `two_factor_expired` (kein/abgelaufener/verbrauchter Schritt, nach 5 Fehlversuchen) · 401 `invalid_code` · 429 |
| `GET /api/auth/2fa` | – | `{enabled, enrolledAt, pending, required, requiredBy: 'platform'\|'tenant'\|null, recoveryCodesRemaining}` |
| `POST /api/auth/2fa/setup` | `{}` | 200 `{secret, otpauthUri, issuer, account}` (neues Geheimnis, 1 h gültig bis zur Bestätigung) · 409 bereits eingerichtet |
| `POST /api/auth/2fa/setup/confirm` | `{code}` | 200 `{recoveryCodes: string[10]}` (nur dieses eine Mal sichtbar); beendet alle anderen Sitzungen des Kontos · 400 `invalid_code` · 409 keine Einrichtung begonnen/abgelaufen · 429 |
| `POST /api/auth/2fa/disable` | `{password, …proof}` | 200 `{setupRequired}` (`true`: Pflichtkonto, danach nur Neueinrichtung möglich) · 400 `invalid_code` „Passwort oder Code ist falsch.“ · 409 nicht eingerichtet · 429 |
| `POST /api/auth/2fa/recovery-codes` | `{password, …proof}` | 200 `{recoveryCodes}` (alte Codes ungültig) · 400 · 409 · 429 |
| `PUT /api/tenants/:tenantId/two-factor-policy` | `{requireTwoFactorForManagers: boolean}` | 200 `Tenant` · 403 nicht Inhaber · 409 Inhaber hat selbst keine 2FA (nur beim Einschalten) |

- Ist 2FA für das Konto Pflicht, aber nicht eingerichtet (Plattformkonten immer, Inhaber/Vorgesetzte bei
  Mandanten-Pflicht), enthält `Session` (Login, `GET /api/auth/session`) `twoFactorSetupRequired: true`, und
  alle fachlichen Endpunkte antworten 403 `two_factor_setup_required`. Erreichbar bleiben `/api/auth/2fa*`,
  `/api/auth/session` und `/api/auth/logout`.
- `Tenant` enthält `requireTwoFactorForManagers`.
- Falsche Codes zählen je Konto (`RATE_LIMIT_2FA_PER_ACCOUNT`) und je IP (`RATE_LIMIT_2FA_PER_IP`).
| `GET /api/health` | – | `{ok: true}` |

**Fachliche Endpunkte** (alle als `app_user`)

| Repository-Methode | Methode, Pfad |
|---|---|
| `getTenant` | `GET /api/tenants/:tenantId` |
| `updateBranding` / `updateContact` / `updateSettings` | `PATCH /api/tenants/:tenantId/branding` · `/contact` · `/settings` (Teil-Objekte, zusammengeführt) |
| Support-Freigabe (UI) | `GET`/`PUT /api/tenants/:tenantId/support-grant` (`{hours: 0–168, reason?}`, 0 = widerrufen) |
| `renameTenant` | `PATCH /api/tenants/:tenantId/name` `{name}` (2–200 Zeichen) → 200 `Tenant` · 403 nicht Inhaber (seit 1.0, Chef-Portal „Firmenprofil“) |
| `listEmployees` / `inviteEmployee` | `GET`/`POST /api/tenants/:tenantId/employees` `{displayName, personnelNumber, email, role, invitation?: "email" \| "link"}` – mit E-Mail → Einladung per Mail (Standard) oder mit `invitation: "link"` einmaliger Link zum Teilen (siehe unten) |
| `updateEmployee` / `setEmployeeStatus` | `PATCH /api/employees/:id` · `POST /api/employees/:id/status` `{status, reason}` |
| `createInvitation` (Zugang senden) | `POST /api/employees/:id/invitation` `{channel?: "email" \| "link"}` → `{invitationId, expiresAt, delivery}`. Jede neue Einladung macht frühere Links der Person ungültig (`create_invitation`), Gültigkeit 7 Tage, einmal verwendbar. `channel: "email"` (Standard): Link nur per Mail an die eingeladene Adresse, `delivery` = `email` (SMTP) · `log` (Entwicklung, Server-Log) · `none` (Produktion ohne SMTP). `channel: "link"`: **keine** Mail, die Antwort enthält einmalig `link` (`PUBLIC_ORIGIN + INVITE_LINK_PATH#token=…`), `delivery: "link"` – für „Per WhatsApp teilen“/„Link kopieren“ im Chef-Portal. Nur Leitung des Mandanten (Leitungspersonen nur Inhaber), nur Status `invited` mit E-Mail-Adresse. Auch `inviteEmployee` liefert `invitation: {expiresAt, delivery, link?}`. Es wird nie ein Passwort versendet. |
| `listTimeEntries` | `GET /api/employees/:id/time-entries?month=YYYY-MM` |
| `listTenantTimeEntries` | `GET /api/tenants/:tenantId/time-entries?from=YYYY-MM-DD&to=YYYY-MM-DD` (max. 400 Tage) |
| `createTimeEntry` | `POST /api/employees/:id/time-entries` `{id, date, start, end, pauseMinutes, note, source?}` → 201 neu, **200 bei bereits vorhandener ID** (idempotent). `source`: nur `"app"` (Standard) oder `"migration"` (Übernahme aus der Alt-App, **nur für eigene Einträge**, sonst 403), wird an `create_time_entry` übergeben; `correction` entsteht nur über Korrekturen |
| `updateTimeEntry` | `PATCH /api/employees/:id/time-entries/:entryId` oder `PATCH /api/time-entries/:entryId` – `{patch, expectedVersion, reason?}` |
| `deleteTimeEntry` | `DELETE` (gleiche Pfade) – `{expectedVersion, reason?}` (Soft-Delete) |
| `listAllocations` / `setAllocation` | `GET /api/employees/:id/allocations` · `PUT /api/employees/:id/allocations/:month` `{minutes}` |
| `reviewAllocation` | `POST /api/employees/:id/allocations/:month/review` `{decision, reason}` |
| `listStatements` / `getStatement` | `GET /api/tenants/:tenantId/statements?month=` · `GET /api/employees/:id/statements/:month` – freigegebene Abschlüsse mit `correctedAfterApproval: {count, lastAt}` (sonst `null`), siehe N1 in `docs/database.md` |
| `listCorrectionRequests` | `GET /api/tenants/:tenantId/correction-requests?employeeId=&status=` (RLS: Mitarbeitende nur eigene, Leitung den Mandanten, Plattform nur mit Freigabe; max. 500, neueste zuerst). `CorrectionRequest` enthält `before`/`proposed` (`{date,start,end,pauseMinutes,note}`), `status`, `decisionNote`, `decidedByName` (nur sichtbar, wenn die Person für den Aufrufer sichtbar ist) |
| `createCorrectionRequest` | `POST /api/employees/:id/correction-requests` `{kind: "change"\|"delete"\|"add", entryId?, proposed?, reason}` → 201. Nur für das eigene Konto (sonst 403). `change`: geänderte Felder genügen; `add`: Datum, Beginn, Ende, Pause Pflicht. Vorab wie bei der Erfassung geprüft: Überschneidung (409 `overlap`), Pausenregeln (400 `break_rule`), 12 h/Pause (400); zweite offene Anfrage zum Eintrag 409 `invalid_state` |
| `withdrawCorrectionRequest` | `POST /api/correction-requests/:id/withdraw` `{}` → 200 · 403 fremd · 409 nicht mehr offen |
| `decideCorrectionRequest` | `POST /api/correction-requests/:id/decide` `{decision: "accepted"\|"rejected", note?}` (`note` Pflicht bei Ablehnung) → 200 · 403 Mitarbeitende/fremder Mandant/eigene Anfrage (außer Inhaber) · 409 bereits entschieden oder Eintrag seit der Anfrage geändert (`version_conflict`) · 409 `overlap` · 400 `break_rule` (Pausenregeln des Tages nach dem Annehmen, Rollback – Anfrage bleibt offen) |
| `listTimeEntryRevisions` | `GET /api/employees/:id/time-entries/:entryId/revisions` → Versionen (älteste zuerst): `{version, operation, isCorrection, changedAt, changedByName, reason, values, deleted, source}` |
| `submitStatement` | `POST /api/employees/:id/statements/:month/submit` |
| `approveStatement` / `returnStatement` | `POST /api/statements/:id/approve` · `POST /api/statements/:id/return` `{reason}` |
| `listAudit` | `GET /api/tenants/:tenantId/audit?limit=` |
| `listTenants` / `createTenant` | `GET`/`POST /api/platform/tenants` – `POST` `{name, slug, plan, isDemo, ownerEmail, ownerName?, freeOfCharge?, conditionNote?, conditionValidUntil?}`: mit `freeOfCharge: true` (nicht bei `pilot_free`) entsteht in derselben Transaktion ein **kostenloser Testkunde** (Sonderkondition „kostenloses Konto“, optional befristet; Audit-Grund „Kostenloser Testkunde bei Anlage“) |
| `setTenantStatus` / `setLicense` | `POST /api/platform/tenants/:id/status` `{status: "active" \| "suspended" \| "pending" \| "deactivated", reason}` (Super-Admin; `deactivated` seit 0015: Vertrag beendet, keine Anmeldung, keine Daten gelöscht) · `PUT /api/platform/tenants/:id/license` `{plan, maxEmployees?, validUntil?, note?, features?, employeePriceCents?, freeOfCharge?, conditionNote?, conditionValidFrom?, conditionValidUntil?, reason?}` (Sonderkondition seit 0012; nur gesendete Felder werden geändert, `reason` landet im Audit) |
| Plattform-Audit (UI) | `GET /api/platform/audit?limit=` (Mandant, Lizenz, Supportfreigabe, Abrechnungsstatus, Standardpreis) |
| `getSystemOverview` | `GET /api/platform/system` (Super-Admin, Support) → `{version, commit, serverTime, uptimeSeconds, nodeVersion, production, database: {reachable, time}, migrations: {count, latest, appliedAt} \| null, activeSessions, tenants: {<status>: Anzahl}, mail: {configured, delivery}, paymentProvider, lastBackupAt}` – nur Zustände und Zahlen, **keine Geheimnisse** (kein SMTP-Host/-Benutzer/-Passwort, keine Datenbank-URL, keine Schlüssel) und keine Personendaten. `commit` aus `APP_COMMIT`, `lastBackupAt` aus `BACKUP_STATUS_FILE` (sonst `null` = „nicht bekannt“), Migrationsstand aus `ops.schema_migrations` über `public.platform_system_overview()` (0015) |

**Abrechnung (Preismodell, `docs/preismodell.md`)**

| Repository-Methode | Methode, Pfad | Wer |
|---|---|---|
| `getTenantBilling` | `GET /api/tenants/:tenantId/billing?month=YYYY-MM` → `TenantBillingMonth` (mit Namen) · 400 künftiger Monat | Inhaber, Leitung |
| `listTenantBillingHistory` | `GET /api/tenants/:tenantId/billing/history?limit=1–36` → `BillingMonthSummary[]` | Inhaber, Leitung |
| `getPlatformRevenue` | `GET /api/platform/billing?month=` → `{month, defaultPriceCents, rows: PlatformRevenueRow[], totals: {billableCount, amountCents, waivedCents, demoAmountCents}, paymentProvider: "none"}` – nur Zahlen | Super-Admin, Support |
| `getBillingSettings` / `setDefaultPrice` | `GET` / `PUT /api/platform/billing/settings` `{defaultPriceCents, reason}` | lesen: Plattform; ändern: Super-Admin |
| `setBillingStatus` | `PUT /api/platform/tenants/:tenantId/billing/:month` `{status, note?}` → `BillingMonthSummary` · 409 laufender/künftiger Monat · 400 ohne Grund bei `waived`/Wiederöffnen | Super-Admin |

`setEmployeeStatus` (`POST /api/employees/:id/status`) akzeptiert seit 0012 `{status: "active" | "locked" | "deactivated", reason}`.
Gesperrte Personen haben sofort keinen Zugriff mehr (bestehende Sitzungen: 403), die Anmeldung antwortet wie bei
falschem Passwort (B4).

Zahlungsdienstleister: `PAYMENT_PROVIDER` (nur `none`, Standard) – siehe `server/src/payment.ts`; es gibt keinen
Endpunkt, der Zahlungen auslöst.

**Fachregeln in der API**
- **Korrekturanfragen** (seit 0013) laufen nie über die Offline-Warteschlange der Mitarbeiter-App: ohne Verbindung
  meldet die App „Korrekturanfragen können nur mit Internetverbindung gestellt werden.“ Angenommene Anfragen werden wie
  jede Korrektur behandelt (Herkunft `correction`, Revision, Audit, Pausenprüfung in derselben Transaktion).
- Ändert/löscht jemand den Eintrag einer **anderen** Person (Leitung), läuft das als Korrektur über
  `correct_time_entry` (Begründung ≥ 5 Zeichen Pflicht, Herkunft `correction`, Audit-Eintrag).
  Eigene Einträge laufen über `update_time_entry`/`delete_time_entry` (Monatssperre gilt).
- **Pausenregeln** (Schwellen, 15-Minuten-Abschnitte, Tagessumme ≤ max. Einsatzdauer) prüft die API
  nach dem Schreiben in derselben Transaktion mit `platform/src/core/breaks.ts` und der
  `breakPolicy` des Mandanten; bei Verstoß Rollback und 400 mit dem deutschen Text aus dem Core.
  Schreibzugriffe je Mitarbeiter sind dafür per `pg_advisory_xact_lock` serialisiert.
  Vor dem Einreichen eines Monats wird derselbe Check für alle Tage des Monats ausgeführt.
- **Pausenregel des Mandanten** (`PATCH /api/tenants/:id/settings`, nur Inhaber): Schwellen aufsteigend,
  nie laxer als § 4 ArbZG (bei mehr als 6 h ≥ 30 min, bei mehr als 9 h ≥ 45 min, Pausenabschnitte ≥ 15 min),
  sonst 400 mit deutschem Text; die Datenbank prüft dasselbe (Migration 0014). Siehe
  [pausenregeln.md](pausenregeln.md).
- Logos/Bildmarken: nur PNG/JPEG/WebP (Data-URL ≤ 300 KB, Signatur geprüft), https-URL oder
  relativer Pfad; **SVG wird abgelehnt** (XSS-Risiko). Seit 0008 lehnt auch die DB-Prüfung SVG ab.
