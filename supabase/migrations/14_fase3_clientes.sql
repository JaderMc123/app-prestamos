alter table public.clients
  add column neighborhood text,
  add column phone2 text,
  add column occupation text,
  add column reference_name text,
  add column reference_phone text,
  add column photo_path text,
  add column data_consent_method text check (data_consent_method in ('casilla','firma','foto')),
  add column data_consent_signature_path text,
  add column blocked_by_admin boolean not null default false,
  add column blocked_reason text,
  add column blocked_at timestamptz,
  add column client_uuid uuid unique;

create table public.client_blocks (
  client_id uuid not null references public.clients(id) on delete cascade,
  collector_id uuid not null references public.profiles(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  reason text,
  created_at timestamptz not null default now(),
  primary key (client_id, collector_id)
);
create index client_blocks_org_idx on public.client_blocks(organization_id);
create index client_blocks_collector_idx on public.client_blocks(collector_id);
alter table public.client_blocks enable row level security;
create policy client_blocks_select on public.client_blocks for select to authenticated
  using (organization_id = (select app.current_org_id()) and ((select app.is_admin()) or collector_id = (select auth.uid())));

create table public.collector_route_orders (
  collector_id uuid primary key references public.profiles(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  loan_ids uuid[] not null default '{}',
  updated_at timestamptz not null default now()
);
create index collector_route_orders_org_idx on public.collector_route_orders(organization_id);
alter table public.collector_route_orders enable row level security;
create policy route_orders_all on public.collector_route_orders for all to authenticated
  using (collector_id = (select auth.uid()))
  with check (collector_id = (select auth.uid()) and organization_id = (select app.current_org_id()));

alter table public.loans add column was_overdue boolean not null default false;
update public.loans set was_overdue = true where status = 'en_mora';
create index loans_client_overdue_idx on public.loans(client_id) where was_overdue;

-- Alerta de cliente riesgoso a partir de 3 préstamos que hayan caído en mora (ajustable)
alter table public.platform_settings add column risk_overdue_threshold integer not null default 3 check (risk_overdue_threshold > 0);

create or replace function app.mark_overdue() returns trigger
language plpgsql set search_path = '' as $$
begin
  if new.status = 'en_mora' then new.was_overdue := true; end if;
  return new;
end $$;
create trigger trg_loans_mark_overdue before insert or update of status on public.loans
  for each row execute function app.mark_overdue();

create or replace function public.upsert_client(
  p_document text, p_full_name text, p_phone text, p_neighborhood text, p_address text,
  p_latitude numeric default null, p_longitude numeric default null,
  p_phone2 text default null, p_occupation text default null,
  p_reference_name text default null, p_reference_phone text default null, p_notes text default null,
  p_consent boolean default false, p_consent_method text default null,
  p_client_uuid uuid default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
  v_uid uuid := auth.uid();
  v_doc text := upper(regexp_replace(coalesce(p_document, ''), '[^0-9A-Za-z]', '', 'g'));
  v_id uuid;
begin
  if v_org is null then raise exception 'NO_AUTORIZADO'; end if;
  if p_client_uuid is not null then
    select id into v_id from public.clients where client_uuid = p_client_uuid and organization_id = v_org;
    if found then return v_id; end if;
  end if;
  if v_doc = '' then raise exception 'DATO_REQUERIDO: escribe la cédula'; end if;
  if coalesce(trim(p_full_name), '') = '' or coalesce(trim(p_phone), '') = '' or coalesce(trim(p_neighborhood), '') = '' or coalesce(trim(p_address), '') = '' then
    raise exception 'DATO_REQUERIDO: nombre, teléfono, barrio y dirección son obligatorios';
  end if;

  select id into v_id from public.clients where organization_id = v_org and document_number = v_doc;
  if found then
    update public.clients set
      full_name = trim(p_full_name), phone = trim(p_phone), neighborhood = trim(p_neighborhood), address = trim(p_address),
      latitude = coalesce(p_latitude, latitude), longitude = coalesce(p_longitude, longitude),
      phone2 = coalesce(nullif(trim(p_phone2), ''), phone2), occupation = coalesce(nullif(trim(p_occupation), ''), occupation),
      reference_name = coalesce(nullif(trim(p_reference_name), ''), reference_name),
      reference_phone = coalesce(nullif(trim(p_reference_phone), ''), reference_phone),
      notes = coalesce(nullif(trim(p_notes), ''), notes),
      data_consent_method = case when p_consent and not data_consent_accepted then p_consent_method else data_consent_method end,
      data_consent_accepted = data_consent_accepted or coalesce(p_consent, false)
    where id = v_id;
    return v_id;
  end if;

  insert into public.clients(organization_id, document_number, full_name, phone, neighborhood, address, latitude, longitude,
    phone2, occupation, reference_name, reference_phone, notes, data_consent_accepted, data_consent_method, created_by, client_uuid)
  values (v_org, v_doc, trim(p_full_name), trim(p_phone), trim(p_neighborhood), trim(p_address), p_latitude, p_longitude,
    nullif(trim(p_phone2), ''), nullif(trim(p_occupation), ''), nullif(trim(p_reference_name), ''), nullif(trim(p_reference_phone), ''),
    nullif(trim(p_notes), ''), coalesce(p_consent, false), case when p_consent then p_consent_method end, v_uid, p_client_uuid)
  returning id into v_id;
  return v_id;
end $$;

drop function if exists public.find_client_by_document(text);
create or replace function public.find_client_by_document(p_document text) returns jsonb
language plpgsql stable security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
  v_uid uuid := auth.uid();
  v_doc text := upper(regexp_replace(coalesce(p_document, ''), '[^0-9A-Za-z]', '', 'g'));
  v_c public.clients%rowtype;
  v_overdue int;
  v_threshold int;
begin
  if v_org is null then raise exception 'NO_AUTORIZADO'; end if;
  select risk_overdue_threshold into v_threshold from public.platform_settings;
  select count(*) into v_overdue from public.loans l join public.clients c on c.id = l.client_id
  where c.document_number = v_doc and l.was_overdue;

  select * into v_c from public.clients where organization_id = v_org and document_number = v_doc;
  return jsonb_build_object(
    'found', v_c.id is not null,
    'risky', v_overdue >= v_threshold,
    'client', case when v_c.id is null then null else jsonb_build_object(
      'id', v_c.id, 'document_number', v_c.document_number, 'full_name', v_c.full_name, 'phone', v_c.phone,
      'neighborhood', v_c.neighborhood, 'address', v_c.address, 'latitude', v_c.latitude, 'longitude', v_c.longitude,
      'phone2', v_c.phone2, 'occupation', v_c.occupation, 'reference_name', v_c.reference_name, 'reference_phone', v_c.reference_phone,
      'data_consent_accepted', v_c.data_consent_accepted,
      'blocked_by_admin', v_c.blocked_by_admin, 'blocked_reason', v_c.blocked_reason,
      'blocked_by_me', exists (select 1 from public.client_blocks b where b.client_id = v_c.id and b.collector_id = v_uid),
      'active_loans', (select count(*) from public.loans l where l.client_id = v_c.id and l.status in ('activo','en_mora'))
    ) end
  );
end $$;

create or replace function public.set_client_block(p_client_id uuid, p_blocked boolean, p_reason text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
  v_uid uuid := auth.uid();
  v_c public.clients%rowtype;
begin
  if v_org is null then raise exception 'NO_AUTORIZADO'; end if;
  select * into v_c from public.clients where id = p_client_id and organization_id = v_org;
  if not found then raise exception 'CLIENTE_NO_ENCONTRADO'; end if;

  if app.is_admin() then
    update public.clients set blocked_by_admin = p_blocked, blocked_reason = case when p_blocked then p_reason end,
      blocked_at = case when p_blocked then now() end where id = p_client_id;
    if p_blocked then
      insert into public.notifications(organization_id, recipient_id, type, title, body, data)
      select v_org, p.id, 'cliente_bloqueado', 'No prestar más', v_c.full_name || coalesce(': ' || p_reason, ''),
        jsonb_build_object('client_id', p_client_id)
      from public.profiles p where p.organization_id = v_org and p.role = 'cobrador' and p.is_active;
    end if;
  else
    if not app.can_see_client(p_client_id) then raise exception 'NO_AUTORIZADO'; end if;
    if p_blocked then
      insert into public.client_blocks(client_id, collector_id, organization_id, reason) values (p_client_id, v_uid, v_org, p_reason)
      on conflict (client_id, collector_id) do update set reason = excluded.reason, created_at = now();
      perform app.notify_admins(v_org, 'cliente_bloqueado_cobrador', 'Cobrador marcó "no prestar más"',
        coalesce((select full_name from public.profiles where id = v_uid), 'Un cobrador') || ' marcó a ' || v_c.full_name || coalesce(': ' || p_reason, ''),
        jsonb_build_object('client_id', p_client_id, 'collector_id', v_uid));
    else
      delete from public.client_blocks where client_id = p_client_id and collector_id = v_uid;
    end if;
  end if;
end $$;

revoke all on function public.upsert_client(text, text, text, text, text, numeric, numeric, text, text, text, text, text, boolean, text, uuid) from public, anon;
revoke all on function public.find_client_by_document(text) from public, anon;
revoke all on function public.set_client_block(uuid, boolean, text) from public, anon;
grant execute on function public.upsert_client(text, text, text, text, text, numeric, numeric, text, text, text, text, text, boolean, text, uuid),
  public.find_client_by_document(text), public.set_client_block(uuid, boolean, text) to authenticated;
revoke all on function app.mark_overdue() from public;
