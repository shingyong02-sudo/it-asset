-- ============================================================
-- 006_profile_dept.sql — 使用者增加「單位」「分機」，申請核准時帶入
-- 在 005 之後於 SQL Editor 執行一次
-- ============================================================
alter table public.profiles add column if not exists dept text;
alter table public.profiles add column if not exists ext  text;
grant update (role, active, display_name, dept, ext) on public.profiles to authenticated;

create or replace function public.decide_account_request(p_id bigint, p_approve boolean, p_role text, p_note text)
returns void
language plpgsql security definer set search_path = public, private, extensions, auth, pg_temp as $$
declare
  r public.account_requests;
  v_id uuid := gen_random_uuid();
begin
  if private.app_role() is distinct from 'admin' then raise exception '只有管理者可處理申請'; end if;
  perform private.require_recent_login();
  select * into r from public.account_requests where id = p_id for update;
  if not found or r.status <> 'pending' then raise exception '這筆申請已處理或不存在'; end if;

  if not p_approve then
    update public.account_requests
       set status = 'rejected', note = nullif(trim(coalesce(p_note, '')), ''), decided_by = auth.uid(), decided_at = now()
     where id = p_id;
    return;
  end if;

  if r.kind = 'reset' then
    update auth.users set encrypted_password = r.password_hash, updated_at = now() where lower(email) = lower(r.email);
    if not found then raise exception '找不到這個帳號'; end if;
    update public.account_requests
       set status = 'approved', note = nullif(trim(coalesce(p_note, '')), ''), decided_by = auth.uid(), decided_at = now()
     where id = p_id;
    return;
  end if;

  if p_role not in ('admin','it','auditor') then raise exception '請先指定角色'; end if;
  if exists (select 1 from auth.users where lower(email) = lower(r.email)) then raise exception '這個 Email 已經有帳號'; end if;

  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, email_change, email_change_token_new, recovery_token)
  values (
    '00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', lower(r.email),
    r.password_hash, now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('name', r.name),
    now(), now(), '', '', '', '');

  insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), v_id, v_id::text,
          jsonb_build_object('sub', v_id::text, 'email', lower(r.email), 'email_verified', true),
          'email', now(), now(), now());

  update public.profiles
     set role = p_role, active = true, display_name = r.name, dept = r.dept, ext = r.ext
   where id = v_id;

  update public.account_requests
     set status = 'approved', role = p_role, user_id = v_id, note = nullif(trim(coalesce(p_note, '')), ''),
         decided_by = auth.uid(), decided_at = now()
   where id = p_id;
end $$;
revoke all on function public.decide_account_request(bigint,boolean,text,text) from public, anon;
grant execute on function public.decide_account_request(bigint,boolean,text,text) to authenticated;
