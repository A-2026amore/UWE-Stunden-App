-- 0026_invitation_existing_account_session.sql
-- Security fix (review "Sicherheitsprüfung mit vier Werkzeugen", 01.11.2026): pre-registered account takeover.
--
-- Before: an invitation for an address that already has an account was linked to that account by anyone
-- holding the invitation token, without any proof of owning the account (0008). Combined with the
-- "link" channel (the manager receives the one-time link of a NEW address and can set its password
-- herself), a manager could pre-create an account for a foreign address and later receive every role
-- that address is invited to – e.g. the owner role of a new company created by the platform.
--
-- Now: linking an invitation to an EXISTING account needs a signed-in session of exactly that account.
-- The API passes the session's user id (p_session_user); without it, or for another account, the
-- function raises PT401 and nothing changes. New accounts are unchanged (password required).
-- The previous two-argument function is dropped so no caller can bypass the check.
-- Additive otherwise; 0001–0025 stay unchanged.

drop function auth.accept_invitation(text, text);

-- p_password_hash:
--   new account      → required (sets the password)
--   existing account → must be NULL (PT409 otherwise, as before)
-- p_session_user:
--   existing account → must be the id of that account (signed-in session), PT401 otherwise
--   new account      → ignored
create function auth.accept_invitation(p_token text, p_password_hash text, p_session_user uuid) returns uuid
language plpgsql volatile security definer
set search_path = ''
as $$
declare
  v_tok auth.one_time_tokens;
  v_inv public.invitations;
  v_user uuid;
begin
  select * into v_tok from auth.one_time_tokens t
   where t.token_hash = private.hash_token(p_token) and t.purpose = 'invitation'
     and t.used_at is null and t.expires_at > now()
   for update;
  if v_tok.id is not null then
    select * into v_inv from public.invitations i
     where i.id = v_tok.invitation_id and i.accepted_at is null and i.revoked_at is null and i.expires_at > now();
  end if;
  if v_inv.id is null then
    raise exception 'Die Einladung ist ungültig oder abgelaufen.' using errcode = '22023';
  end if;

  select u.id into v_user from auth.users u where u.email = v_inv.email;
  if v_user is null then
    if p_password_hash is null then
      raise exception 'Bitte ein Passwort festlegen.' using errcode = '22023';
    end if;
    insert into auth.users (email, password_hash) values (v_inv.email, p_password_hash) returning id into v_user;
  elsif p_password_hash is not null then
    raise exception 'Für diese E-Mail-Adresse gibt es bereits ein Benutzerkonto. Bitte melde dich zuerst mit deinem bisherigen Passwort an und öffne den Link danach noch einmal.'
      using errcode = 'PT409';
  elsif p_session_user is null or p_session_user <> v_user then
    raise exception 'Für diese E-Mail-Adresse gibt es bereits ein Benutzerkonto. Bitte melde dich zuerst mit genau diesem Konto an und öffne den Link danach noch einmal.'
      using errcode = 'PT401';
  end if;

  update public.employees e set user_id = v_user, status = 'active'
   where e.id = v_inv.employee_id and e.tenant_id = v_inv.tenant_id and e.user_id is null;
  if not found then
    raise exception 'Die Einladung wurde bereits verwendet.' using errcode = '55000';
  end if;
  update public.invitations set accepted_at = now() where id = v_inv.id;
  update auth.one_time_tokens set used_at = now() where id = v_tok.id;
  return v_user;
end
$$;

revoke all on function auth.accept_invitation(text, text, uuid) from public;
grant execute on function auth.accept_invitation(text, text, uuid) to app_auth;
