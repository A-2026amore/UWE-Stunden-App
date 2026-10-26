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
| `set_employee_status(employee_id, 'active'/'deactivated', reason)` | invoker | `setEmployeeStatus` |
| `create_invitation(employee_id, valid_days=7) → {invitationId, token, expiresAt}` | definer | `inviteEmployee` (nach Insert in `employees`) |
| `grant_support_access(tenant_id, hours, reason, grantee?)`, `revoke_support_access(grant_id)` | definer | Inhaber-Einstellungen |
| `platform_list_tenants()` – nur Metadaten und Zahlen | definer | `listTenants` |
| `create_tenant(name, slug, plan, is_demo, owner_email, owner_name?, contact?) → {tenantId, licenseId, ownerEmployeeId, invitationToken}` | definer | `createTenant` |
| `set_tenant_status(tenant_id, status, reason)` | invoker | `setTenantStatus` |

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
| `auth.resolve_session(token) → (session_id, user_id, expires_at)` | je Anfrage; leeres Ergebnis = abgemeldet |
| `auth.revoke_session(token) → boolean` | Abmelden |
| `auth.create_password_reset(email) → token \| null` | Link per E-Mail; Antwort an den Client immer gleich |
| `auth.reset_password(token, password_hash) → user_id` | setzt Hash, beendet alle Sitzungen |
| `auth.accept_invitation(token, password_hash) → user_id` | legt Konto an (oder nutzt vorhandenes), aktiviert Mitarbeiter |

Ablauf je Anfrage: Cookie → `resolve_session` (als `app_auth`) → `user_id` →
neue Transaktion als `app_user` mit `request.jwt.claims.sub = user_id`.
