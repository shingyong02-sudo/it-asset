-- ============================================================
-- 004_mfa.sql — 強制動態驗證碼（TOTP）：資料庫層級
-- 前提：Supabase → Authentication → Sign In / Providers → Multi-Factor 的 TOTP 已啟用（預設即啟用）
-- 執行前請先部署新版網頁；執行後，所有人登入後都必須輸入動態驗證碼才能存取資料
-- ============================================================

-- 只有通過動態驗證碼（aal2）的登入者才有角色
create or replace function private.app_role() returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select role from public.profiles
   where id = auth.uid() and active and coalesce(auth.jwt() ->> 'aal', '') = 'aal2'
$$;

-- 重新確認身分：180 秒內必須剛輸入過動態驗證碼
create or replace function private.require_recent_login(p_max_age int default 180) returns void
language plpgsql stable set search_path = public, pg_temp as $$
begin
  if not exists (
    select 1
      from jsonb_array_elements(coalesce(auth.jwt() -> 'amr', '[]'::jsonb)) a
     where a ->> 'method' = 'totp'
       and (a ->> 'timestamp')::bigint > extract(epoch from now())::bigint - p_max_age
  ) then
    raise exception 'REAUTH_REQUIRED: 請重新輸入動態驗證碼確認身分';
  end if;
end $$;

-- 管理者重設某人的動態驗證碼（手機遺失、換機）
create or replace function public.admin_reset_mfa(p_user_id uuid, p_reason text) returns void
language plpgsql security definer set search_path = public, private, auth, pg_temp as $$
declare v_email text;
begin
  if private.app_role() is distinct from 'admin' then raise exception '只有管理者可重設動態驗證碼'; end if;
  if length(trim(coalesce(p_reason, ''))) < 4 then raise exception '請填寫原因（至少 4 字）'; end if;
  perform private.require_recent_login();
  select email into v_email from public.profiles where id = p_user_id;
  if v_email is null then raise exception '找不到使用者'; end if;
  delete from auth.mfa_factors where user_id = p_user_id;
  perform private.audit_insert('RESET_MFA', 'profiles', p_user_id::text, null, v_email, null, null, null, trim(p_reason));
end $$;

revoke all on function public.admin_reset_mfa(uuid, text) from public, anon;
grant execute on function public.admin_reset_mfa(uuid, text) to authenticated;
