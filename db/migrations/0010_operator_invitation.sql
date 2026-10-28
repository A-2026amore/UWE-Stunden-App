-- 0010_operator_invitation.sql
-- Operator invitation without e-mail (QA 2026-10-28, finding B1). Additive; 0001–0009 stay unchanged.
--
-- Without SMTP an invitation link only reaches the invited person by e-mail –
-- the API never returns it, and production logs never contain it. For operation
-- without a mail server (test environment, first setup) the operator creates
-- the link on the server console instead:
--
--   node … server/src/cli.ts invite-link <tenant-slug> <email> <role>
--
-- auth.operator_create_invitation is executable ONLY by app_auth (same level as
-- the existing operator command set-password, which uses
-- auth.create_password_reset + auth.reset_password). No HTTP route calls it.
-- The token is returned once; only its SHA-256 hash is stored.
--
-- Behaviour:
--  * tenant by slug (any status; a suspended tenant's members still cannot sign in)
--  * an employee row of that tenant with this e-mail that is still 'invited'
--    and not linked to an account is reused (same role required); otherwise a
--    new row is created (status 'invited', personnel number 'CLI-…',
--    display name = given name or the local part of the e-mail)
--  * a row that is already linked to an account (or deactivated) is refused
--  * open invitations of that employee are revoked, a new one is created
--  * audit: employee/invitation rows are audited by the existing triggers,
--    reason "Einladung über Betreiberbefehl (CLI)", actor NULL (operator)

create or replace function auth.operator_create_invitation(
  p_tenant_slug text, p_email text, p_role text, p_display_name text default null, p_valid_days integer default 7
) returns jsonb
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_tenant public.tenants;
  v_email text := lower(btrim(coalesce(p_email, '')));
  v_name text;
  v_emp public.employees;
  v_inv public.invitations;
  v_token text := private.new_token();
  v_created boolean := false;
begin
  if p_role is null or p_role not in ('employee', 'manager', 'owner') then
    raise exception 'Rolle muss employee, manager oder owner sein.' using errcode = '22023';
  end if;
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(v_email) > 254 then
    raise exception 'Ungültige E-Mail-Adresse.' using errcode = '22023';
  end if;
  if p_valid_days is null or p_valid_days not between 1 and 30 then
    raise exception 'Gültigkeit muss zwischen 1 und 30 Tagen liegen.' using errcode = '22023';
  end if;

  select * into v_tenant from public.tenants t where t.slug = lower(btrim(coalesce(p_tenant_slug, '')));
  if v_tenant.id is null then
    raise exception 'Mandant nicht gefunden.' using errcode = 'P0002';
  end if;

  perform set_config('app.change_reason', 'Einladung über Betreiberbefehl (CLI)', true);

  -- Several rows with the same e-mail are possible (employees.email is not unique):
  -- prefer an open invitation row, else any row (which is then refused below).
  select * into v_emp from public.employees e
   where e.tenant_id = v_tenant.id and lower(e.email) = v_email
   order by (e.status = 'invited' and e.user_id is null) desc, e.created_at
   limit 1;

  if v_emp.id is not null then
    if v_emp.user_id is not null or v_emp.status <> 'invited' then
      raise exception 'Für diese E-Mail-Adresse gibt es in diesem Mandanten bereits einen aktiven oder deaktivierten Zugang.'
        using errcode = '55000';
    end if;
    if v_emp.role <> p_role then
      raise exception 'Für diese E-Mail-Adresse ist bereits eine Einladung mit der Rolle % angelegt.', v_emp.role
        using errcode = '55000';
    end if;
  else
    v_name := left(btrim(coalesce(nullif(btrim(p_display_name), ''), split_part(v_email, '@', 1))), 120);
    insert into public.employees (tenant_id, personnel_number, display_name, email, role, status)
    values (v_tenant.id, 'CLI-' || upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 10)),
            v_name, v_email, p_role, 'invited')
    returning * into v_emp;
    v_created := true;
  end if;

  update public.invitations i set revoked_at = now()
   where i.employee_id = v_emp.id and i.accepted_at is null and i.revoked_at is null;

  insert into public.invitations (tenant_id, employee_id, email, created_by, expires_at)
  values (v_tenant.id, v_emp.id, v_email, null, now() + make_interval(days => p_valid_days))
  returning * into v_inv;
  insert into auth.one_time_tokens (purpose, email, invitation_id, token_hash, expires_at)
  values ('invitation', v_email, v_inv.id, private.hash_token(v_token), v_inv.expires_at);

  perform set_config('app.change_reason', '', true);

  return jsonb_build_object(
    'tenantName', v_tenant.name, 'tenantStatus', v_tenant.status,
    'employeeId', v_emp.id, 'role', v_emp.role, 'createdEmployee', v_created,
    'invitationId', v_inv.id, 'token', v_token, 'expiresAt', v_inv.expires_at);
end
$$;

revoke all on function auth.operator_create_invitation(text, text, text, text, integer) from public;
grant execute on function auth.operator_create_invitation(text, text, text, text, integer) to app_auth;
