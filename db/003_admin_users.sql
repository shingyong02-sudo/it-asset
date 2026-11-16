-- ============================================================
-- 003_admin_users.sql — 管理者在系統內新增使用者（不需到 Supabase 後台）
-- 在 001、002 之後於 SQL Editor 執行一次
-- ============================================================
create or replace function public.admin_create_user(p_email text, p_password text, p_name text, p_role text)
returns uuid
language plpgsql security definer set search_path = public, private, extensions, auth, pg_temp as $$
declare
  v_id uuid := gen_random_uuid();
  v_email text := lower(trim(coalesce(p_email, '')));
begin
  if private.app_role() is distinct from 'admin' then raise exception '只有管理者可新增使用者'; end if;
  perform private.require_recent_login();
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' then raise exception 'Email 格式不正確'; end if;
  if length(coalesce(p_password, '')) < 8 then raise exception '密碼至少 8 個字元'; end if;
  if p_role not in ('admin','it','auditor') then raise exception '角色不正確'; end if;
  if exists (select 1 from auth.users where lower(email) = v_email) then raise exception '這個 Email 已經有帳號'; end if;

  insert into auth.users (
    instance_id, id, aud, role, email, encrypted_password, email_confirmed_at,
    raw_app_meta_data, raw_user_meta_data, created_at, updated_at,
    confirmation_token, email_change, email_change_token_new, recovery_token)
  values (
    '00000000-0000-0000-0000-000000000000', v_id, 'authenticated', 'authenticated', v_email,
    crypt(p_password, gen_salt('bf')), now(),
    '{"provider":"email","providers":["email"]}'::jsonb,
    jsonb_build_object('name', nullif(trim(coalesce(p_name, '')), '')),
    now(), now(), '', '', '', '');

  insert into auth.identities (id, user_id, provider_id, identity_data, provider, last_sign_in_at, created_at, updated_at)
  values (gen_random_uuid(), v_id, v_id::text,
          jsonb_build_object('sub', v_id::text, 'email', v_email, 'email_verified', true),
          'email', now(), now(), now());

  -- profiles 由 auth.users 觸發器自動建立（未啟用），這裡指派角色並啟用
  update public.profiles
     set role = p_role, active = true,
         display_name = coalesce(nullif(trim(coalesce(p_name, '')), ''), display_name)
   where id = v_id;

  return v_id;
end $$;

revoke all on function public.admin_create_user(text,text,text,text) from public, anon;
grant execute on function public.admin_create_user(text,text,text,text) to authenticated;
