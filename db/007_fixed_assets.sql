-- 第一期：組織（部門）、財產建檔＋自動編號＋折舊、移轉／報廢簽核
-- 保管人沿用 public.people；稽核沿用既有 audit_row 觸發器（雜湊鏈不可修改）

-- 1. 部門／單位
create table public.departments (
  id uuid primary key default gen_random_uuid(),
  site_id smallint not null references public.sites(id),
  name text not null,
  notes text,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  unique (site_id, name)
);

-- 2. 財產分類（代碼用於編號）
create table public.asset_categories (
  code text primary key check (code ~ '^[A-Z]{1,2}$'),
  name text not null,
  sort int not null default 0
);
insert into public.asset_categories (code, name, sort) values
  ('M', '醫療設備', 1), ('C', '電腦設備', 2), ('N', '網路／通訊設備', 3),
  ('O', '辦公設備', 4), ('F', '家具', 5), ('V', '車輛', 6), ('Z', '其他', 9);

-- 3. 財產
create table public.fixed_assets (
  id uuid primary key default gen_random_uuid(),
  asset_no text unique,                                   -- 自動產生：院區代碼-分類-年度-流水號
  site_id smallint not null references public.sites(id),
  category text not null references public.asset_categories(code),
  name text not null,
  brand_model text,
  serial_no text,
  dept_id uuid references public.departments(id),
  custodian_id uuid references public.people(id),
  location text,
  acquired_date date not null,
  cost numeric(14,0) not null default 0 check (cost >= 0),
  salvage_value numeric(14,0) not null default 0 check (salvage_value >= 0),
  useful_life_months int not null default 60 check (useful_life_months > 0),
  status text not null default 'in_use' check (status in ('in_use','scrapped')),
  scrapped_at date,
  notes text,
  created_at timestamptz not null default now(), created_by uuid,
  updated_at timestamptz not null default now(), updated_by uuid,
  check (salvage_value <= cost)
);
create index fixed_assets_site_idx on public.fixed_assets (site_id, category);
create index fixed_assets_cust_idx on public.fixed_assets (custodian_id);

create table public.asset_no_seq (
  site_id smallint not null, category text not null, yr int not null, last int not null default 0,
  primary key (site_id, category, yr)
);
revoke all on public.asset_no_seq from anon, authenticated;

create function private.assign_asset_no() returns trigger
language plpgsql security definer set search_path = public, private, pg_temp as $$
declare v_site text; v_n int;
begin
  if new.asset_no is not null and new.asset_no <> '' then return new; end if;
  select code into v_site from public.sites where id = new.site_id;
  insert into public.asset_no_seq (site_id, category, yr, last)
    values (new.site_id, new.category, extract(year from new.acquired_date)::int, 1)
  on conflict (site_id, category, yr) do update set last = public.asset_no_seq.last + 1
  returning last into v_n;
  new.asset_no := v_site || '-' || new.category || '-' || extract(year from new.acquired_date)::int || '-' || lpad(v_n::text, 4, '0');
  return new;
end $$;
create trigger fixed_assets_no before insert on public.fixed_assets
  for each row execute function private.assign_asset_no();

-- 編號建立後不可改
create function private.lock_asset_no() returns trigger language plpgsql as $$
begin
  if new.asset_no is distinct from old.asset_no then raise exception '財產編號不可修改'; end if;
  return new;
end $$;
create trigger fixed_assets_lockno before update on public.fixed_assets
  for each row execute function private.lock_asset_no();

-- 4. 折舊檢視（直線法，按月）
create view public.v_fixed_assets with (security_invoker = true) as
select a.*,
  c.name as category_name,
  d.name as dept_name,
  p.name as custodian_name,
  s.name as site_name,
  least(a.useful_life_months, greatest(0,
    (extract(year from age(coalesce(a.scrapped_at, current_date), a.acquired_date)) * 12
     + extract(month from age(coalesce(a.scrapped_at, current_date), a.acquired_date)))::int)) as months_used,
  round((a.cost - a.salvage_value) / a.useful_life_months
        * least(a.useful_life_months, greatest(0,
          (extract(year from age(coalesce(a.scrapped_at, current_date), a.acquired_date)) * 12
           + extract(month from age(coalesce(a.scrapped_at, current_date), a.acquired_date)))::int))) as accumulated_dep,
  a.cost - round((a.cost - a.salvage_value) / a.useful_life_months
        * least(a.useful_life_months, greatest(0,
          (extract(year from age(coalesce(a.scrapped_at, current_date), a.acquired_date)) * 12
           + extract(month from age(coalesce(a.scrapped_at, current_date), a.acquired_date)))::int))) as book_value
from public.fixed_assets a
join public.asset_categories c on c.code = a.category
join public.sites s on s.id = a.site_id
left join public.departments d on d.id = a.dept_id
left join public.people p on p.id = a.custodian_id;

-- 5. 簽核（移轉／報廢）：只能經 RPC 建立與決定
create table public.approvals (
  id uuid primary key default gen_random_uuid(),
  kind text not null check (kind in ('transfer','scrap')),
  asset_id uuid not null references public.fixed_assets(id),
  to_custodian_id uuid references public.people(id),
  to_dept_id uuid references public.departments(id),
  to_location text,
  reason text not null,
  status text not null default 'pending' check (status in ('pending','approved','rejected','cancelled')),
  requested_by uuid not null, requested_at timestamptz not null default now(),
  decided_by uuid, decided_at timestamptz, decision_note text
);
create unique index approvals_one_pending on public.approvals (asset_id) where status = 'pending';

create function public.request_approval(
  p_kind text, p_asset uuid, p_reason text,
  p_to_custodian uuid default null, p_to_dept uuid default null, p_to_location text default null
) returns uuid
language plpgsql security definer set search_path = public, private, pg_temp as $$
declare v_id uuid; v_a public.fixed_assets;
begin
  if private.app_role() not in ('admin','it') then raise exception '沒有權限'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception '請填寫原因'; end if;
  select * into v_a from public.fixed_assets where id = p_asset;
  if not found then raise exception '找不到財產'; end if;
  if v_a.status <> 'in_use' then raise exception '此財產已報廢'; end if;
  if p_kind = 'transfer' and p_to_custodian is null and p_to_dept is null and coalesce(p_to_location,'') = '' then
    raise exception '請至少指定新保管人、部門或存放地點';
  end if;
  insert into public.approvals (kind, asset_id, to_custodian_id, to_dept_id, to_location, reason, requested_by)
    values (p_kind, p_asset, p_to_custodian, p_to_dept, nullif(trim(p_to_location),''), trim(p_reason), auth.uid())
    returning id into v_id;
  perform private.audit_insert('REQUEST_' || upper(p_kind), 'fixed_assets', p_asset::text, v_a.site_id,
    v_a.asset_no || ' ' || v_a.name, null, jsonb_build_object('approval_id', v_id, 'reason', p_reason), null, p_reason);
  return v_id;
end $$;

create function public.decide_approval(p_id uuid, p_approve boolean, p_note text default null) returns void
language plpgsql security definer set search_path = public, private, pg_temp as $$
declare v public.approvals; v_a public.fixed_assets; v_other int;
begin
  if private.app_role() <> 'admin' then raise exception '只有管理者可以簽核'; end if;
  select * into v from public.approvals where id = p_id for update;
  if not found or v.status <> 'pending' then raise exception '此申請已處理或不存在'; end if;
  select count(*) into v_other from public.profiles where role = 'admin' and active and id <> auth.uid();
  if v.requested_by = auth.uid() and v_other > 0 then raise exception '申請人不可簽核自己的申請'; end if;
  select * into v_a from public.fixed_assets where id = v.asset_id for update;

  update public.approvals set status = case when p_approve then 'approved' else 'rejected' end,
    decided_by = auth.uid(), decided_at = now(), decision_note = p_note where id = p_id;

  if p_approve then
    perform set_config('app.approval_apply', '1', true);
    if v.kind = 'transfer' then
      update public.fixed_assets set
        custodian_id = coalesce(v.to_custodian_id, custodian_id),
        dept_id = coalesce(v.to_dept_id, dept_id),
        location = coalesce(v.to_location, location) where id = v.asset_id;
    else
      update public.fixed_assets set status = 'scrapped', scrapped_at = current_date where id = v.asset_id;
    end if;
  end if;
  perform private.audit_insert(case when p_approve then 'APPROVE_' else 'REJECT_' end || upper(v.kind), 'fixed_assets',
    v.asset_id::text, v_a.site_id, v_a.asset_no || ' ' || v_a.name, null,
    jsonb_build_object('approval_id', p_id, 'note', p_note), null, p_note);
end $$;

create function public.cancel_approval(p_id uuid) returns void
language plpgsql security definer set search_path = public, private, pg_temp as $$
begin
  update public.approvals set status = 'cancelled', decided_by = auth.uid(), decided_at = now()
   where id = p_id and status = 'pending' and (requested_by = auth.uid() or private.app_role() = 'admin');
  if not found then raise exception '無法取消'; end if;
end $$;

-- 6. 觸發器、稽核、RLS
do $$
declare t text;
begin
  foreach t in array array['departments','fixed_assets'] loop
    execute format('create trigger %I before insert or update on public.%I for each row execute function private.stamp()', t || '_stamp', t);
  end loop;
  foreach t in array array['departments','fixed_assets','approvals'] loop
    execute format('create trigger %I after insert or update or delete on public.%I for each row execute function private.audit_row()', t || '_audit', t);
    execute format('alter table public.%I enable row level security', t);
    execute format('create policy %I on public.%I for select to authenticated using (private.app_role() is not null)', t || '_sel', t);
  end loop;
  foreach t in array array['departments','fixed_assets'] loop
    execute format('create policy %I on public.%I for insert to authenticated with check (private.app_role() in (''admin'',''it''))', t || '_ins', t);
    execute format('create policy %I on public.%I for update to authenticated using (private.app_role() in (''admin'',''it'')) with check (private.app_role() in (''admin'',''it''))', t || '_upd', t);
    execute format('create policy %I on public.%I for delete to authenticated using (private.app_role() = ''admin'')', t || '_del', t);
  end loop;
end $$;
alter table public.asset_categories enable row level security;
create policy asset_categories_sel on public.asset_categories for select to authenticated using (private.app_role() is not null);

grant select on public.asset_categories, public.approvals, public.v_fixed_assets to authenticated;
grant select, insert, update, delete on public.departments to authenticated;
-- 財產：保管人／部門／地點變更與報廢必須走簽核，故不開放直接修改這些欄位
grant select, delete on public.fixed_assets to authenticated;
grant insert (site_id, category, name, brand_model, serial_no, dept_id, custodian_id, location, acquired_date,
              cost, salvage_value, useful_life_months, notes) on public.fixed_assets to authenticated;
grant update (name, brand_model, serial_no, acquired_date, cost, salvage_value, useful_life_months, notes, category)
  on public.fixed_assets to authenticated;
grant execute on function public.request_approval(text, uuid, text, uuid, uuid, text),
                          public.decide_approval(uuid, boolean, text),
                          public.cancel_approval(uuid) to authenticated;
