-- 0007_grants.sql
-- Privileges. Principle: request roles get only what the RLS policies are
-- written for; everything else is denied. Run after all objects exist.
-- New migrations that add tables/functions must add their grants explicitly.

-- ---------------------------------------------------------------- reset

revoke all on all tables in schema public from public, app_anon, app_user, app_auth;
revoke all on all tables in schema auth from public, app_anon, app_user, app_auth;
revoke all on all functions in schema public from public, app_anon, app_user, app_auth;
revoke all on all functions in schema auth from public, app_anon, app_user, app_auth;
revoke all on all functions in schema private from public, app_anon, app_user, app_auth;
revoke create on schema public from public;

grant usage on schema public, auth, private to app_anon, app_user, app_auth, app_service;

-- ---------------------------------------------------------------- request identity

grant execute on function auth.uid(), auth.jwt() to app_anon, app_user, app_auth, app_service;

-- ---------------------------------------------------------------- helper functions
-- Called from RLS policies and SECURITY INVOKER triggers, therefore executable
-- by app_user. private.write_audit is deliberately NOT granted (no forged audit).

grant execute on function
  private.is_app_role(),
  private.has_tenant_role(uuid, text[]),
  private.is_member(uuid),
  private.is_manager(uuid),
  private.is_owner(uuid),
  private.is_own_employee(uuid, uuid),
  private.is_platform_admin(text[]),
  private.has_support_access(uuid),
  private.can_read_personal(uuid),
  private.tenant_status(uuid),
  private.tenant_settings(uuid),
  private.employee_status(uuid),
  private.is_month_locked(uuid, date),
  private.license_employee_limit(uuid),
  private.active_employee_count(uuid),
  private.assert_keys(jsonb, text[]),
  private.require_reason(text, integer, text),
  private.assert_month(text),
  private.shift_minutes(time, time),
  private.json_int_ok(jsonb, bigint, bigint),
  private.json_text_ok(jsonb, boolean, integer, text),
  private.json_bool_ok(jsonb),
  private.is_valid_branding(jsonb),
  private.is_valid_contact(jsonb),
  private.is_valid_tenant_settings(jsonb),
  private.default_branding(),
  private.default_tenant_settings()
to app_user, app_service;

-- ---------------------------------------------------------------- tables for app_user

grant select, insert, update on public.tenants                  to app_user;
grant select, insert, update on public.licenses                 to app_user;
grant select, insert, update on public.employees                to app_user;
grant select                 on public.platform_admins          to app_user;
grant select                 on public.support_access_grants    to app_user;
grant select                 on public.invitations              to app_user;
grant select, insert, update on public.time_entries             to app_user;
grant select                 on public.time_entry_revisions     to app_user;
grant select, insert, update on public.work_account_allocations to app_user;
grant select                 on public.monthly_statements       to app_user;
grant select                 on public.audit_log                to app_user;
-- No DELETE and no TRUNCATE anywhere for app_user.

-- ---------------------------------------------------------------- RPCs

grant execute on function public.public_tenant_branding(text) to app_anon, app_user;

grant execute on function
  public.current_session_context(),
  public.create_time_entry(uuid, jsonb),
  public.update_time_entry(uuid, text, jsonb, integer, text),
  public.delete_time_entry(uuid, text, integer, text),
  public.correct_time_entry(uuid, text, jsonb, integer, text),
  public.set_allocation(uuid, text, integer),
  public.review_allocation(uuid, text, text, text),
  public.submit_statement(uuid, text),
  public.approve_statement(uuid),
  public.return_statement(uuid, text),
  public.set_employee_status(uuid, text, text),
  public.create_invitation(uuid, integer),
  public.grant_support_access(uuid, integer, text, uuid),
  public.revoke_support_access(uuid),
  public.platform_list_tenants(),
  public.create_tenant(text, text, text, boolean, text, text, jsonb),
  public.set_tenant_status(uuid, text, text)
to app_user;

-- ---------------------------------------------------------------- login handling (app_auth)

grant select, insert, update on auth.users, auth.sessions, auth.one_time_tokens to app_auth;
grant execute on function
  auth.get_login(text),
  auth.create_session(uuid, interval, text),
  auth.resolve_session(text),
  auth.revoke_session(text),
  auth.create_password_reset(text),
  auth.reset_password(text, text),
  auth.accept_invitation(text, text)
to app_auth;
grant execute on function private.hash_token(text), private.new_token() to app_auth;

-- ---------------------------------------------------------------- maintenance (app_service, BYPASSRLS)
-- Used only by operator jobs (retention purge, exports), never by request handling.

grant select, insert, update, delete on all tables in schema public to app_service;
grant select, insert, update, delete on all tables in schema auth to app_service;
revoke update, delete on public.audit_log from app_service;
