-- ============================================================
-- 002_functions.sql — 加密金鑰、密碼查看／變更／匯入 RPC、儀表板、稽核驗證
-- 在 001_schema.sql 之後執行
-- ============================================================

-- ---- 加密金鑰（只能由 DBA 在 SQL Editor 設定一次；前端無法呼叫）----
create function private.set_encryption_key(p_key text) returns void
language plpgsql security definer set search_path = public, private, pg_temp as $$
begin
  if length(coalesce(p_key, '')) < 24 then
    raise exception '金鑰長度至少 24 字元';
  end if;
  if exists (select 1 from private.app_settings where key = 'enc_key') then
    raise exception '金鑰已設定。更換金鑰會讓既有密碼無法解密，請改用重新加密程序';
  end if;
  insert into private.app_settings (key, value) values ('enc_key', p_key);
end $$;
revoke all on function private.set_encryption_key(text) from public, anon, authenticated;

create function private.enc_key() returns text
language plpgsql security definer set search_path = public, private, pg_temp as $$
declare k text;
begin
  select value into k from private.app_settings where key = 'enc_key';
  if k is null then raise exception 'KEY_NOT_SET: 尚未設定加密金鑰'; end if;
  return k;
end $$;
revoke all on function private.enc_key() from public, anon, authenticated;

-- ---- 近期重新驗證：登入密碼確認（180 秒內）----
create function private.require_recent_login(p_max_age int default 180) returns void
language plpgsql stable set search_path = public, pg_temp as $$
begin
  if not exists (
    select 1
      from jsonb_array_elements(coalesce(auth.jwt() -> 'amr', '[]'::jsonb)) a
     where a ->> 'method' = 'password'
       and (a ->> 'timestamp')::bigint > extract(epoch from now())::bigint - p_max_age
  ) then
    raise exception 'REAUTH_REQUIRED: 請重新輸入登入密碼確認身分';
  end if;
end $$;
revoke all on function private.require_recent_login(int) from public, anon;
grant execute on function private.require_recent_login(int) to authenticated;

-- ---- 查看密碼（含歷史密碼）----
create function public.reveal_secret(p_credential_id uuid, p_reason text, p_history_id bigint default null)
returns text
language plpgsql security definer set search_path = public, private, extensions, pg_temp as $$
declare
  r text := private.app_role();
  enc bytea; plain text; v_host text; v_acct text; v_site smallint;
begin
  if r is null or r not in ('admin','it') then raise exception '沒有查看密碼的權限'; end if;
  if p_history_id is not null and r <> 'admin' then raise exception '只有管理者可查看歷史密碼'; end if;
  if length(trim(coalesce(p_reason, ''))) < 4 then raise exception '請填寫查看原因（至少 4 字）'; end if;
  perform private.require_recent_login();

  if (select count(*) from public.audit_logs
       where actor_id = auth.uid() and action = 'REVEAL' and at > now() - interval '1 hour') >= 30 then
    raise exception '1 小時內查看次數過多，請稍後再試';
  end if;

  select h.site_id, h.name, c.account into v_site, v_host, v_acct
    from public.credentials c join public.hosts h on h.id = c.host_id where c.id = p_credential_id;
  if not found then raise exception '找不到這筆帳號'; end if;

  if p_history_id is null then
    select secret_enc into enc from public.credentials where id = p_credential_id;
  else
    select secret_enc into enc from public.credential_history where id = p_history_id and credential_id = p_credential_id;
  end if;
  if enc is null then raise exception '這筆帳號尚未設定密碼'; end if;

  plain := pgp_sym_decrypt(enc, private.enc_key());

  perform private.audit_insert('REVEAL', 'credentials', p_credential_id::text, v_site,
    v_host || ' / ' || coalesce(v_acct, ''), null,
    case when p_history_id is null then null else jsonb_build_object('history_id', p_history_id) end,
    null, trim(p_reason));
  return plain;
end $$;

-- ---- 設定／變更密碼（舊密碼加密留存，紀錄不含明碼）----
create function public.set_credential_secret(p_credential_id uuid, p_secret text, p_reason text)
returns void
language plpgsql security definer set search_path = public, private, extensions, pg_temp as $$
declare
  r text := private.app_role();
  cur bytea; v_host text; v_acct text; v_site smallint; first_time boolean;
begin
  if r is null or r not in ('admin','it') then raise exception '沒有變更密碼的權限'; end if;
  if length(coalesce(p_secret, '')) < 1 then raise exception '密碼不可空白'; end if;
  if length(trim(coalesce(p_reason, ''))) < 4 then raise exception '請填寫變更原因（至少 4 字）'; end if;
  perform private.require_recent_login();

  select c.secret_enc, h.site_id, h.name, c.account into cur, v_site, v_host, v_acct
    from public.credentials c join public.hosts h on h.id = c.host_id
   where c.id = p_credential_id for update of c;
  if not found then raise exception '找不到這筆帳號'; end if;
  first_time := cur is null;

  if cur is not null then
    insert into public.credential_history (credential_id, secret_enc, replaced_by, reason)
    values (p_credential_id, cur, auth.uid(), trim(p_reason));
  end if;

  update public.credentials
     set secret_enc = pgp_sym_encrypt(p_secret, private.enc_key()),
         secret_set_at = now(),
         rotated_at = case when first_time then rotated_at else now() end
   where id = p_credential_id;

  perform private.audit_insert('SET_SECRET', 'credentials', p_credential_id::text, v_site,
    v_host || ' / ' || coalesce(v_acct, ''), null,
    jsonb_build_object('first_time', first_time), null, trim(p_reason));
end $$;

-- ---- 匯入主機與帳密（僅管理者；前端瀏覽器解析 Excel 後送入）----
create function public.import_credentials(p_rows jsonb, p_reason text) returns jsonb
language plpgsql security definer set search_path = public, private, extensions, pg_temp as $$
declare
  row jsonb; v_site smallint; v_host uuid; v_cred uuid;
  n_host int := 0; n_cred int := 0; n_skip int := 0;
begin
  if private.app_role() is distinct from 'admin' then raise exception '只有管理者可匯入'; end if;
  if length(trim(coalesce(p_reason, ''))) < 4 then raise exception '請填寫匯入原因'; end if;
  perform private.require_recent_login();

  for row in select * from jsonb_array_elements(p_rows) loop
    select id into v_site from public.sites where code = row ->> 'site_code';
    if v_site is null or coalesce(trim(row ->> 'host'), '') = '' then n_skip := n_skip + 1; continue; end if;

    select id into v_host from public.hosts
     where site_id = v_site and name = trim(row ->> 'host')
       and coalesce(address, '') = coalesce(trim(row ->> 'address'), '') limit 1;
    if v_host is null then
      insert into public.hosts (site_id, name, host_type, address)
      values (v_site, trim(row ->> 'host'), coalesce(nullif(row ->> 'host_type', ''), 'other'), nullif(trim(row ->> 'address'), ''))
      returning id into v_host;
      n_host := n_host + 1;
    end if;

    if coalesce(row ->> 'secret', '') = '' and coalesce(row ->> 'account', '') = '' then continue; end if;

    if exists (select 1 from public.credentials
                where host_id = v_host and coalesce(account, '') = coalesce(row ->> 'account', '')
                  and coalesce(purpose, '') = coalesce(row ->> 'purpose', '')) then
      n_skip := n_skip + 1; continue;
    end if;

    insert into public.credentials (host_id, account, purpose, secret_enc, secret_set_at)
    values (v_host, nullif(trim(row ->> 'account'), ''), nullif(trim(row ->> 'purpose'), ''),
            case when coalesce(row ->> 'secret', '') = '' then null
                 else pgp_sym_encrypt(row ->> 'secret', private.enc_key()) end,
            case when coalesce(row ->> 'secret', '') = '' then null else now() end)
    returning id into v_cred;
    n_cred := n_cred + 1;
  end loop;

  perform private.audit_insert('IMPORT', 'credentials', null, null,
    format('匯入主機 %s、帳號 %s、略過 %s', n_host, n_cred, n_skip),
    null, jsonb_build_object('hosts', n_host, 'credentials', n_cred, 'skipped', n_skip), null, trim(p_reason));
  return jsonb_build_object('hosts', n_host, 'credentials', n_cred, 'skipped', n_skip);
end $$;

-- ---- 列出某帳號的歷史密碼清單（只有 id／時間／原因，不含密碼；僅管理者）----
create function public.list_credential_history(p_credential_id uuid)
returns table (id bigint, replaced_at timestamptz, replaced_by_email text, reason text)
language plpgsql stable security definer set search_path = public, private, pg_temp as $$
begin
  if private.app_role() is distinct from 'admin' then raise exception '只有管理者可查看歷史密碼清單'; end if;
  return query
    select h.id, h.replaced_at, p.email, h.reason
      from public.credential_history h left join public.profiles p on p.id = h.replaced_by
     where h.credential_id = p_credential_id order by h.id desc;
end $$;

-- ---- 稽核紀錄鏈驗證 ----
create function public.verify_audit_chain() returns jsonb
language plpgsql security definer set search_path = public, private, extensions, pg_temp as $$
declare total int; bad bigint;
begin
  if private.app_role() not in ('admin','auditor') then raise exception '沒有權限'; end if;
  select count(*) into total from public.audit_logs;
  select min(id) into bad from (
    select l.id,
           l.prev_hash is distinct from lag(l.row_hash) over (order by l.id) as bad_prev,
           l.row_hash is distinct from private.audit_hash(l.prev_hash, l) as bad_hash
      from public.audit_logs l
  ) x where bad_prev or bad_hash;
  return jsonb_build_object('ok', bad is null, 'checked', total, 'first_bad_id', bad);
end $$;

-- ---- 儀表板統計（以呼叫者權限執行）----
create function public.dashboard_stats() returns jsonb
language sql stable security invoker set search_path = public, pg_temp as $$
  select jsonb_build_object(
    'by_site_type', (select coalesce(jsonb_agg(jsonb_build_object('site_id', site_id, 'asset_type', asset_type, 'n', n)), '[]'::jsonb)
                       from (select site_id, asset_type, count(*)::int n from public.assets where status <> 'retired' group by 1, 2) x),
    'dup_ip',     (select count(*) from public.v_ip_conflicts),
    'invalid_ip', (select count(*) from public.assets where ip_text is not null and ip is null and status <> 'retired'),
    'pc_no_ip',   (select count(*) from public.assets where asset_type = 'pc' and ip_text is null and status <> 'retired'),
    'eol_os',     (select count(*) from public.assets where status <> 'retired' and upper(coalesce(os, '')) ~ '(^XP|WIN7|VISTA|SERVER2003|SERVER2008)'),
    'no_person',  (select count(*) from public.assets where asset_type = 'pc' and person_id is null and status <> 'retired'),
    'hosts',      (select count(*) from public.hosts where active),
    'open_tasks', (select count(*) from public.tasks where status in ('待處理','處理中')),
    'people_left_with_assets', (select count(distinct a.id) from public.assets a join public.people p on p.id = a.person_id
                                 where p.status = '離職' and a.status <> 'retired')
  )
$$;

-- ---- 權限：只有登入者可呼叫 RPC ----
do $$
declare f text;
begin
  foreach f in array array[
    'public.reveal_secret(uuid,text,bigint)',
    'public.set_credential_secret(uuid,text,text)',
    'public.import_credentials(jsonb,text)',
    'public.verify_audit_chain()',
    'public.list_credential_history(uuid)',
    'public.dashboard_stats()'
  ] loop
    execute format('revoke all on function %s from public, anon', f);
    execute format('grant execute on function %s to authenticated', f);
  end loop;
end $$;
