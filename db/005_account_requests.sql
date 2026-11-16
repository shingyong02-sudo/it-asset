-- ============================================================
-- 005_account_requests.sql — 登入頁「申請帳號」＋管理者核准／退回
-- 在 001~003 之後於 SQL Editor 執行一次
-- 申請者的密碼只存 bcrypt 雜湊（不存明碼）；核准時直接沿用該雜湊建立帳號。
-- 申請人無法讀取任何資料；角色由管理者在核准時指定。
-- ============================================================
create table if not exists public.account_requests (
  id            bigint generated always as identity primary key,
  kind          text not null default 'new' check (kind in ('new','reset')),   -- new=申請帳號 reset=忘記密碼
  email         text not null,
  name          text not null,
  ext           text not null,
  dept          text not null default '',
  password_hash text not null,
  status        text not null default 'pending' check (status in ('pending','approved','rejected')),
  role          text check (role in ('admin','it','auditor')),
  note          text,
  user_id       uuid,
  created_at    timestamptz not null default now(),
  decided_by    uuid,
  decided_at    timestamptz
);
create index if not exists account_requests_status_idx on public.account_requests(status, created_at);

alter table public.account_requests enable row level security;   -- 不開放任何 policy，只能經下列函式存取
revoke all on public.account_requests from public, anon, authenticated;

-- 公開：送出申請（未登入可呼叫）
create or replace function public.submit_account_request(p_email text, p_name text, p_ext text, p_dept text, p_password text)
returns void
language plpgsql security definer set search_path = public, private, extensions, auth, pg_temp as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
begin
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(v_email) > 120 then raise exception 'Email 格式不正確'; end if;
  if length(trim(coalesce(p_name, ''))) not between 1 and 40 then raise exception '請填寫姓名（40 字內）'; end if;
  if length(trim(coalesce(p_ext, ''))) not between 1 and 20 then raise exception '請填寫分機（20 字內）'; end if;
  if length(trim(coalesce(p_dept, ''))) not between 1 and 60 then raise exception '請填寫單位（60 字內）'; end if;
  if length(coalesce(p_password, '')) < 8 or length(p_password) > 72 then raise exception '密碼需 8～72 個字元'; end if;
  -- 防濫用：待處理申請總數上限；同一 Email 已有待處理或已有帳號時，一律回「已送出」不洩漏細節
  if (select count(*) from public.account_requests where status = 'pending') >= 100 then
    raise exception '目前申請過多，請直接聯絡資訊室';
  end if;
  if exists (select 1 from public.account_requests where lower(email) = v_email and status = 'pending')
     or exists (select 1 from auth.users where lower(email) = v_email) then
    return;
  end if;
  insert into public.account_requests (email, name, ext, dept, password_hash)
  values (v_email, trim(p_name), trim(p_ext), trim(p_dept), crypt(p_password, gen_salt('bf')));
end $$;
revoke all on function public.submit_account_request(text,text,text,text,text) from public;
grant execute on function public.submit_account_request(text,text,text,text,text) to anon, authenticated;

-- 公開：忘記密碼（送出新密碼的雜湊，等管理者確認身分後核准才生效；不洩漏 Email 是否存在）
create or replace function public.submit_password_reset(p_email text, p_name text, p_ext text, p_password text)
returns void
language plpgsql security definer set search_path = public, private, extensions, auth, pg_temp as $$
declare
  v_email text := lower(trim(coalesce(p_email, '')));
begin
  if v_email !~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' or length(v_email) > 120 then raise exception 'Email 格式不正確'; end if;
  if length(trim(coalesce(p_name, ''))) not between 1 and 40 then raise exception '請填寫姓名（40 字內）'; end if;
  if length(trim(coalesce(p_ext, ''))) not between 1 and 20 then raise exception '請填寫分機（20 字內）'; end if;
  if length(coalesce(p_password, '')) < 8 or length(p_password) > 72 then raise exception '密碼需 8～72 個字元'; end if;
  if (select count(*) from public.account_requests where status = 'pending') >= 100 then
    raise exception '目前申請過多，請直接聯絡資訊室';
  end if;
  if exists (select 1 from public.account_requests where lower(email) = v_email and kind = 'reset' and status = 'pending')
     or not exists (select 1 from auth.users where lower(email) = v_email) then
    return;
  end if;
  insert into public.account_requests (kind, email, name, ext, dept, password_hash)
  values ('reset', v_email, trim(p_name), trim(p_ext), '', crypt(p_password, gen_salt('bf')));
end $$;
revoke all on function public.submit_password_reset(text,text,text,text) from public;
grant execute on function public.submit_password_reset(text,text,text,text) to anon, authenticated;

-- 管理者：列出申請
drop function if exists public.list_account_requests();
create or replace function public.list_account_requests()
returns table (id bigint, kind text, email text, name text, ext text, dept text, status text, role text, note text, created_at timestamptz, decided_at timestamptz)
language plpgsql security definer set search_path = public, private, pg_temp as $$
begin
  if private.app_role() is distinct from 'admin' then raise exception '只有管理者可檢視申請'; end if;
  return query
    select r.id, r.kind, r.email, r.name, r.ext, r.dept, r.status, r.role, r.note, r.created_at, r.decided_at
    from public.account_requests r
    order by (r.status = 'pending') desc, r.created_at desc
    limit 500;
end $$;
revoke all on function public.list_account_requests() from public, anon;
grant execute on function public.list_account_requests() to authenticated;

-- 管理者：核准（指定角色）或退回
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
     set role = p_role, active = true, display_name = r.name
   where id = v_id;

  update public.account_requests
     set status = 'approved', role = p_role, user_id = v_id, note = nullif(trim(coalesce(p_note, '')), ''),
         decided_by = auth.uid(), decided_at = now()
   where id = p_id;
end $$;
revoke all on function public.decide_account_request(bigint,boolean,text,text) from public, anon;
grant execute on function public.decide_account_request(bigint,boolean,text,text) to authenticated;
