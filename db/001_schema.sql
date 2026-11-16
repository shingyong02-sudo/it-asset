-- ============================================================
-- 杏和醫療體系 資訊資產與帳密管控系統  V1.0
-- 001_schema.sql  —  請在「新建的」Supabase 專案 SQL Editor 貼上整段執行一次
-- 重要：執行前請先到 Authentication → Sign In / Providers，關閉「Allow new users to sign up」
-- ============================================================

create schema if not exists extensions;
create extension if not exists pgcrypto with schema extensions;

-- 私有 schema：不對外（PostgREST 不暴露），存放加密金鑰與內部函式
create schema if not exists private;
revoke all on schema private from public, anon, authenticated;
grant usage on schema private to authenticated;

create table if not exists private.app_settings (
  key   text primary key,
  value text not null
);
revoke all on private.app_settings from public, anon, authenticated;

-- ------------------------------------------------------------
-- 1. 院區（固定 4 個）
-- ------------------------------------------------------------
create table public.sites (
  id   smallint primary key,
  code text unique not null,
  name text not null,
  sort int  not null default 0
);
insert into public.sites (id, code, name, sort) values
  (1, 'SY', '杏永醫院', 1),
  (2, 'SH', '杏和醫院', 2),
  (3, 'NH', '護理之家', 3),
  (4, 'CL', '診所',     4);

-- ------------------------------------------------------------
-- 2. 系統使用者（對應 Supabase Auth）
--    新註冊者預設 active=false、無角色，須由管理者啟用並指派角色
-- ------------------------------------------------------------
create table public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  email        text,
  display_name text,
  role         text check (role in ('admin','it','auditor')),
  active       boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);

create function private.handle_new_user() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  insert into public.profiles (id, email, display_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data->>'name', split_part(new.email, '@', 1)))
  on conflict (id) do nothing;
  return new;
end $$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function private.handle_new_user();

-- 目前登入者的角色（未啟用者回傳 null）
create function private.app_role() returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select role from public.profiles where id = auth.uid() and active
$$;

-- 不可把最後一位啟用中的管理者降級或停用
create function private.guard_last_admin() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if old.role = 'admin' and old.active and (new.role is distinct from 'admin' or not new.active) then
    if (select count(*) from public.profiles where role = 'admin' and active and id <> old.id) = 0 then
      raise exception '不可停用或降級最後一位管理者';
    end if;
  end if;
  new.updated_at := now();
  return new;
end $$;
create trigger profiles_guard before update on public.profiles
  for each row execute function private.guard_last_admin();

-- ------------------------------------------------------------
-- 3. 通用：建立／修改人與時間
-- ------------------------------------------------------------
create function private.stamp() returns trigger language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    new.created_at := now();
    new.created_by := auth.uid();
  else
    new.created_at := old.created_at;
    new.created_by := old.created_by;
  end if;
  new.updated_at := now();
  new.updated_by := auth.uid();
  return new;
end $$;

-- ------------------------------------------------------------
-- 4. 人員（使用人）
-- ------------------------------------------------------------
create table public.people (
  id          uuid primary key default gen_random_uuid(),
  site_id     smallint references public.sites(id),
  name        text not null,
  dept        text,
  title       text,
  employee_no text,
  ext         text,
  status      text not null default '在職' check (status in ('在職','離職')),
  left_at     date,
  notes       text,
  created_at  timestamptz not null default now(), created_by uuid,
  updated_at  timestamptz not null default now(), updated_by uuid
);

-- ------------------------------------------------------------
-- 5. 資產：電腦／印表機／網路設備／主機／攝影機／門禁／停管
-- ------------------------------------------------------------
create table public.assets (
  id                uuid primary key default gen_random_uuid(),
  site_id           smallint not null references public.sites(id),
  asset_type        text not null default 'pc'
                    check (asset_type in ('pc','printer','network','server','camera','access','parking','other')),
  name              text,                 -- 電腦名稱／位置名稱
  floor             text,
  unit              text,
  location          text,
  brand_model       text,
  os                text,
  office_license    text,
  purchase_date_raw text,                 -- 民國年.月（原樣保留，例：110.7）
  ip_text           text,                 -- 原始輸入
  ip                inet,                 -- 系統解析（格式錯誤時為 null）
  mac               text,
  serial_no         text,
  status            text not null default 'in_use'
                    check (status in ('in_use','spare','repair','retired','lost')),
  person_id         uuid references public.people(id),
  notes             text,
  extra             jsonb not null default '{}'::jsonb,
  source            text,                 -- 資料來源（匯入檔名／手動）
  created_at        timestamptz not null default now(), created_by uuid,
  updated_at        timestamptz not null default now(), updated_by uuid
);
create index assets_site_type_idx on public.assets (site_id, asset_type);
create index assets_ip_text_idx   on public.assets (ip_text);
create index assets_person_idx    on public.assets (person_id);

create function private.asset_prepare() returns trigger language plpgsql as $$
begin
  new.ip_text := nullif(trim(new.ip_text), '');
  begin
    new.ip := new.ip_text::inet;
  exception when others then
    new.ip := null;
  end;
  return new;
end $$;
create trigger assets_prepare before insert or update on public.assets
  for each row execute function private.asset_prepare();

-- ------------------------------------------------------------
-- 6. 主機／系統與帳號（密碼加密存放）
-- ------------------------------------------------------------
create table public.hosts (
  id         uuid primary key default gen_random_uuid(),
  site_id    smallint not null references public.sites(id),
  name       text not null,               -- 設備／系統名稱
  host_type  text not null default 'other'
             check (host_type in ('firewall','nas','server','pacs','web','wifi','software','other')),
  address    text,                        -- IP 或網址
  owner_name text,                        -- 負責人
  notes      text,
  active     boolean not null default true,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid
);

create table public.credentials (
  id            uuid primary key default gen_random_uuid(),
  host_id       uuid not null references public.hosts(id) on delete cascade,
  account       text,
  purpose       text,
  secret_enc    bytea,                    -- 以 pgcrypto 加密，前端永遠讀不到
  secret_set_at timestamptz,
  rotated_at    timestamptz,
  notes         text,
  active        boolean not null default true,
  created_at    timestamptz not null default now(), created_by uuid,
  updated_at    timestamptz not null default now(), updated_by uuid
);
create index credentials_host_idx on public.credentials (host_id);

-- 密碼歷史（加密）：更換密碼時保留舊值，僅管理者可經 RPC 查看並留紀錄
create table public.credential_history (
  id            bigint generated always as identity primary key,
  credential_id uuid not null references public.credentials(id) on delete cascade,
  secret_enc    bytea not null,
  replaced_at   timestamptz not null default now(),
  replaced_by   uuid,
  reason        text
);

-- ------------------------------------------------------------
-- 7. 廠商聯絡人、交辦事項
-- ------------------------------------------------------------
create table public.vendor_contacts (
  id           uuid primary key default gen_random_uuid(),
  site_id      smallint references public.sites(id),
  system_name  text,                      -- 例：HIS、PACS、監視器
  vendor       text,
  contact_name text,
  phone        text,
  notes        text,
  created_at   timestamptz not null default now(), created_by uuid,
  updated_at   timestamptz not null default now(), updated_by uuid
);

create table public.tasks (
  id            uuid primary key default gen_random_uuid(),
  site_id       smallint references public.sites(id),
  title         text not null,
  detail        text,
  status        text not null default '待處理' check (status in ('待處理','處理中','已完成','暫停')),
  owner_name    text,
  vendor        text,
  due_date      date,
  progress_note text,
  created_at    timestamptz not null default now(), created_by uuid,
  updated_at    timestamptz not null default now(), updated_by uuid
);

create table public.kb_articles (
  id         uuid primary key default gen_random_uuid(),
  site_id    smallint references public.sites(id),
  category   text,                         -- 例：PACS、備份、HIS、網路
  title      text not null,
  body       text,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid
);

do $$
declare t text;
begin
  foreach t in array array['people','assets','hosts','credentials','vendor_contacts','tasks','kb_articles'] loop
    execute format('create trigger %I before insert or update on public.%I for each row execute function private.stamp()', t || '_stamp', t);
  end loop;
end $$;

-- ------------------------------------------------------------
-- 8. 稽核紀錄：只能新增、不可修改刪除、雜湊鏈防竄改
-- ------------------------------------------------------------
create table public.audit_logs (
  id            bigint generated always as identity primary key,
  at            timestamptz not null default now(),
  actor_id      uuid,
  actor_email   text,
  actor_role    text,
  action        text not null,            -- INSERT UPDATE DELETE REVEAL SET_SECRET IMPORT
  table_name    text not null,
  record_id     text,
  site_id       smallint,
  summary       text,
  old_data      jsonb,
  new_data      jsonb,
  changed_cols  text[],
  reason        text,
  prev_hash     text,
  row_hash      text
);
create index audit_table_record_idx on public.audit_logs (table_name, record_id);
create index audit_at_idx           on public.audit_logs (at desc);
create index audit_actor_idx        on public.audit_logs (actor_id);

create function private.audit_block() returns trigger language plpgsql as $$
begin
  raise exception 'audit_logs 為不可修改的稽核紀錄';
end $$;
create trigger audit_no_change before update or delete on public.audit_logs
  for each row execute function private.audit_block();
create trigger audit_no_truncate before truncate on public.audit_logs
  for each statement execute function private.audit_block();

create function private.audit_hash(p_prev text, r public.audit_logs) returns text
language sql immutable set search_path = public, extensions, pg_temp as $$
  select encode(digest(concat_ws('|',
    coalesce(p_prev, ''), r.id::text, extract(epoch from r.at)::text,
    coalesce(r.actor_id::text, ''), coalesce(r.actor_email, ''), r.action, r.table_name,
    coalesce(r.record_id, ''), coalesce(r.site_id::text, ''), coalesce(r.summary, ''),
    coalesce(r.old_data::text, ''), coalesce(r.new_data::text, ''),
    coalesce(array_to_string(r.changed_cols, ','), ''), coalesce(r.reason, '')), 'sha256'), 'hex')
$$;

create function private.audit_chain() returns trigger
language plpgsql security definer set search_path = public, private, extensions, pg_temp as $$
declare prev text;
begin
  perform pg_advisory_xact_lock(724301);
  select row_hash into prev from public.audit_logs order by id desc limit 1;
  new.prev_hash := prev;
  new.row_hash  := private.audit_hash(prev, new);
  return new;
end $$;
create trigger audit_chain before insert on public.audit_logs
  for each row execute function private.audit_chain();

-- 寫入一筆稽核事件（含目前操作者資訊）
create function private.audit_insert(
  p_action text, p_table text, p_record text, p_site smallint, p_summary text,
  p_old jsonb, p_new jsonb, p_cols text[], p_reason text
) returns void
language plpgsql security definer set search_path = public, private, extensions, pg_temp as $$
declare a_id uuid := auth.uid(); a_email text; a_role text;
begin
  if a_id is not null then
    select email, role into a_email, a_role from public.profiles where id = a_id;
  end if;
  insert into public.audit_logs
    (actor_id, actor_email, actor_role, action, table_name, record_id, site_id, summary, old_data, new_data, changed_cols, reason)
  values
    (a_id, coalesce(a_email, '(資料庫直接操作)'), a_role, p_action, p_table, p_record, p_site, p_summary, p_old, p_new, p_cols, p_reason);
end $$;

-- 資料表異動觸發器（密碼本體永不寫入紀錄，只記「密碼已變更」）
create function private.audit_row() returns trigger
language plpgsql security definer set search_path = public, private, extensions, pg_temp as $$
declare
  o jsonb; n jsonb; cols text[]; rid text; sid smallint; summ text;
  skip text[] := array['updated_at','updated_by','created_at','created_by'];
begin
  if tg_op in ('UPDATE','DELETE') then o := to_jsonb(old); end if;
  if tg_op in ('INSERT','UPDATE') then n := to_jsonb(new); end if;

  if tg_table_name = 'credentials' then
    skip := skip || array['secret_set_at','rotated_at'];
    if o is not null then o := (o - 'secret_enc') || jsonb_build_object('has_secret', old.secret_enc is not null); end if;
    if n is not null then n := (n - 'secret_enc') || jsonb_build_object('has_secret', new.secret_enc is not null); end if;
  elsif tg_table_name = 'assets' then
    skip := skip || array['ip'];
  end if;

  rid := coalesce(n, o)->>'id';
  if tg_table_name = 'credentials' then
    select h.site_id, h.name into sid, summ from public.hosts h where h.id = (coalesce(n, o)->>'host_id')::uuid;
    summ := coalesce(summ, '') || ' / ' || coalesce(coalesce(n, o)->>'account', '');
  else
    sid  := nullif(coalesce(n, o)->>'site_id', '')::smallint;
    summ := coalesce(coalesce(n, o)->>'name', coalesce(n, o)->>'title', coalesce(n, o)->>'email', coalesce(n, o)->>'vendor', '');
  end if;

  if tg_op = 'UPDATE' then
    select array_agg(e.key order by e.key) into cols
      from jsonb_each(n) e where not (e.key = any(skip)) and (o -> e.key) is distinct from e.value;
    if cols is null then return null; end if;     -- 無實質變更（例如只換密碼，由 RPC 另記）
  end if;

  perform private.audit_insert(tg_op, tg_table_name, rid, sid, summ, o, n, cols, null);
  return null;
end $$;

do $$
declare t text;
begin
  foreach t in array array['profiles','people','assets','hosts','credentials','vendor_contacts','tasks','kb_articles'] loop
    execute format('create trigger %I after insert or update or delete on public.%I for each row execute function private.audit_row()', t || '_audit', t);
  end loop;
end $$;

-- ------------------------------------------------------------
-- 9. 檢視：IP 衝突
-- ------------------------------------------------------------
create view public.v_ip_conflicts with (security_invoker = true) as
  select ip_text,
         count(*)::int as n,
         array_agg(coalesce(name, '(無名稱)') order by name) as names,
         array_agg(id) as ids
    from public.assets
   where status <> 'retired' and ip_text is not null
   group by ip_text
  having count(*) > 1;

-- ------------------------------------------------------------
-- 10. 權限（RLS）：未登入者什麼都讀不到
-- ------------------------------------------------------------
revoke all on all tables in schema public from anon, authenticated;
alter table public.sites              enable row level security;
alter table public.profiles           enable row level security;
alter table public.audit_logs         enable row level security;
alter table public.credential_history enable row level security;   -- 不開放任何 policy

create policy sites_sel on public.sites for select to authenticated using (private.app_role() is not null);
grant select on public.sites to authenticated;

create policy profiles_sel on public.profiles for select to authenticated
  using (id = auth.uid() or private.app_role() = 'admin');
create policy profiles_upd on public.profiles for update to authenticated
  using (private.app_role() = 'admin') with check (private.app_role() = 'admin');
grant select on public.profiles to authenticated;
grant update (role, active, display_name) on public.profiles to authenticated;

create policy audit_sel on public.audit_logs for select to authenticated
  using (private.app_role() in ('admin','auditor')
         or (private.app_role() = 'it' and table_name <> 'profiles'));
grant select on public.audit_logs to authenticated;

do $$
declare t text;
begin
  foreach t in array array['people','assets','hosts','credentials','vendor_contacts','tasks','kb_articles'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select to authenticated using (private.app_role() is not null)', t || '_sel', t);
    execute format('create policy %I on public.%I for insert to authenticated with check (private.app_role() in (''admin'',''it''))', t || '_ins', t);
    execute format('create policy %I on public.%I for update to authenticated using (private.app_role() in (''admin'',''it'')) with check (private.app_role() in (''admin'',''it''))', t || '_upd', t);
    execute format('create policy %I on public.%I for delete to authenticated using (private.app_role() = ''admin'')', t || '_del', t);
  end loop;
end $$;

grant select, insert, update, delete on public.people, public.assets, public.hosts,
      public.vendor_contacts, public.tasks, public.kb_articles to authenticated;
grant select on public.v_ip_conflicts to authenticated;

-- credentials：前端不可讀寫 secret_enc / secret_set_at / rotated_at（只能經 RPC）
grant select (id, host_id, account, purpose, secret_set_at, rotated_at, notes, active,
              created_at, created_by, updated_at, updated_by) on public.credentials to authenticated;
grant insert (host_id, account, purpose, notes, active) on public.credentials to authenticated;
grant update (account, purpose, notes, active) on public.credentials to authenticated;
grant delete on public.credentials to authenticated;

grant execute on function private.app_role() to authenticated;
