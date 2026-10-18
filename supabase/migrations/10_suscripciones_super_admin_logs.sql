-- ===== Plataforma =====
create table public.platform_settings (
  id boolean primary key default true check (id),
  grace_days integer not null default 5 check (grace_days >= 0),
  default_subscription_price numeric(14,2) not null default 0 check (default_subscription_price >= 0),
  reminder_days integer[] not null default '{5,3,1}',
  updated_at timestamptz not null default now()
);
insert into public.platform_settings default values;
create trigger trg_platform_updated before update on public.platform_settings for each row execute function app.set_updated_at();

-- ===== Organización: identificador y suscripción =====
alter table public.organizations
  add column code text unique check (code ~ '^[a-z0-9-]{3,20}$' and code <> 'sistema'),
  add column subscription_price numeric(14,2) not null default 0 check (subscription_price >= 0),
  add column subscription_exempt boolean not null default false,
  add column discount_type public.discount_type,
  add column discount_value numeric(14,2) not null default 0 check (discount_value >= 0),
  add column discount_reason text,
  add column subscription_ends_at date,
  add column grace_days_override integer check (grace_days_override >= 0),
  add column suspended boolean not null default false,
  add column suspended_reason text;
alter table public.organizations alter column code set not null;

-- ===== Perfiles: súper admin sin organización, último uso =====
alter table public.profiles alter column organization_id drop not null;
alter table public.profiles add column last_seen_at timestamptz;
alter table public.profiles add constraint profiles_org_by_role
  check ((role = 'super_admin') = (organization_id is null));
create unique index profiles_super_username_uniq on public.profiles(username) where organization_id is null;

-- ===== Pagos de suscripción =====
create table public.subscription_payments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  months integer not null check (months > 0),
  period_start date not null,
  period_end date not null,
  list_price numeric(14,2) not null,
  discount_amount numeric(14,2) not null default 0,
  amount_charged numeric(14,2) not null,
  exempt boolean not null default false,
  method text,
  reference text,
  notes text,
  paid_at timestamptz not null default now(),
  registered_by uuid references public.profiles(id) on delete set null
);
create index subscription_payments_org_idx on public.subscription_payments(organization_id, paid_at desc);
create index subscription_payments_by_idx on public.subscription_payments(registered_by);

-- ===== Logs =====
create table public.audit_logs (
  id bigint generated always as identity primary key,
  organization_id uuid references public.organizations(id) on delete cascade,
  actor_id uuid references public.profiles(id) on delete set null,
  action text not null,
  entity text not null,
  entity_id text,
  changed_fields text[],
  created_at timestamptz not null default now()
);
create index audit_logs_org_idx on public.audit_logs(organization_id, created_at desc);
create index audit_logs_actor_idx on public.audit_logs(actor_id);
create index audit_logs_created_idx on public.audit_logs(created_at desc);

create table public.error_logs (
  id bigint generated always as identity primary key,
  organization_id uuid references public.organizations(id) on delete cascade,
  user_id uuid references public.profiles(id) on delete set null,
  source text not null default 'frontend' check (source in ('frontend','database','edge')),
  level text not null default 'error' check (level in ('error','warning','info')),
  message text not null,
  context jsonb not null default '{}'::jsonb,
  url text,
  user_agent text,
  created_at timestamptz not null default now()
);
create index error_logs_org_idx on public.error_logs(organization_id, created_at desc);
create index error_logs_user_idx on public.error_logs(user_id);
create index error_logs_created_idx on public.error_logs(created_at desc);

-- ===== Funciones de acceso =====
create or replace function app.is_super_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'super_admin' and is_active)
$$;

-- full = acceso completo · readonly = periodo de gracia · blocked = sin acceso
create or replace function app.org_access_level(p_org uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when o.id is null then 'blocked'
    when o.suspended then 'blocked'
    when o.subscription_ends_at is null then 'full'
    when (now() at time zone o.timezone)::date <= o.subscription_ends_at then 'full'
    when (now() at time zone o.timezone)::date
         <= o.subscription_ends_at + coalesce(o.grace_days_override, ps.grace_days) then 'readonly'
    else 'blocked' end
  from public.platform_settings ps
  left join public.organizations o on o.id = p_org
$$;

create or replace function app.subscription_amount(p_org uuid) returns numeric
language sql stable security definer set search_path = '' as $$
  select case when o.subscription_exempt then 0
    else greatest(o.subscription_price - case
      when o.discount_type = 'porcentaje' then round(o.subscription_price * o.discount_value / 100, 2)
      when o.discount_type = 'fijo' then o.discount_value
      else 0 end, 0) end
  from public.organizations o where o.id = p_org
$$;

-- La organización bloqueada deja de ser visible para sus usuarios
create or replace function app.current_org_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select p.organization_id from public.profiles p
  where p.id = auth.uid() and p.is_active and p.organization_id is not null
    and app.org_access_level(p.organization_id) <> 'blocked'
$$;

-- Bloqueo de escritura cuando la suscripción no está al día
create or replace function app.guard_org_write() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_org uuid;
begin
  if auth.uid() is null or app.is_super_admin() then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  if tg_op = 'DELETE' then v_org := old.organization_id; else v_org := new.organization_id; end if;
  if app.org_access_level(v_org) <> 'full' then
    raise exception 'SUSCRIPCION_VENCIDA: la suscripción está vencida, la cuenta está en modo solo lectura';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['clients','loans','loan_installments','payments','payment_allocations','capital_movements',
    'expenses','collection_logs','cash_closures','payment_accounts','settings','collection_schedules','fixed_costs',
    'client_assignment_history'] loop
    execute format('create trigger trg_guard_write before insert or update or delete on public.%I
                    for each row execute function app.guard_org_write()', t);
  end loop;
end $$;

-- ===== Auditoría automática =====
create or replace function app.audit_row() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_new jsonb; v_old jsonb; j jsonb;
  v_fields text[];
begin
  if tg_op <> 'DELETE' then v_new := to_jsonb(new); end if;
  if tg_op <> 'INSERT' then v_old := to_jsonb(old); end if;
  j := coalesce(v_new, v_old);
  if tg_op = 'UPDATE' then
    select array_agg(n.key order by n.key) into v_fields
    from jsonb_each(v_new) n
    where n.value is distinct from v_old -> n.key and n.key not in ('updated_at','last_seen_at');
    if v_fields is null then return new; end if;
  end if;
  insert into public.audit_logs(organization_id, actor_id, action, entity, entity_id, changed_fields)
  values (
    case when tg_table_name = 'organizations' then (j->>'id')::uuid else app.safe_uuid(j->>'organization_id') end,
    auth.uid(),
    lower(tg_op), tg_table_name,
    coalesce(j->>'id', j->>'organization_id'),
    v_fields);
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

do $$
declare t text;
begin
  foreach t in array array['organizations','profiles','settings','clients','loans','payments','capital_movements',
    'expenses','cash_closures','client_assignment_history','payment_accounts','collection_schedules',
    'subscription_payments','fixed_costs'] loop
    execute format('create trigger trg_audit after insert or update or delete on public.%I
                    for each row execute function app.audit_row()', t);
  end loop;
end $$;

-- ===== Alta de usuarios: solo vía servidor (app_metadata) =====
create or replace function app.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_role text := new.raw_app_meta_data->>'role';
  v_org uuid := app.safe_uuid(new.raw_app_meta_data->>'organization_id');
  v_name text := coalesce(new.raw_user_meta_data->>'full_name', new.raw_app_meta_data->>'username', new.email);
begin
  if v_role = 'super_admin' then
    insert into public.profiles(id, organization_id, full_name, username, phone, role, can_view_total_capital)
    values (new.id, null, v_name, new.raw_app_meta_data->>'username', new.raw_user_meta_data->>'phone', 'super_admin', true);
  elsif v_role in ('admin','cobrador') and v_org is not null then
    insert into public.profiles(id, organization_id, full_name, username, phone, role, can_view_total_capital)
    values (new.id, v_org, v_name, new.raw_app_meta_data->>'username', new.raw_user_meta_data->>'phone',
            v_role::public.user_role, v_role = 'admin');
    if v_role = 'cobrador' then
      insert into public.collection_schedules(collector_id, organization_id) values (new.id, v_org);
    end if;
  else
    raise exception 'REGISTRO_NO_PERMITIDO: los usuarios solo los crea un administrador';
  end if;
  return new;
end $$;

-- ===== RLS de nuevas tablas y permisos del súper admin =====
alter table public.platform_settings enable row level security;
alter table public.subscription_payments enable row level security;
alter table public.audit_logs enable row level security;
alter table public.error_logs enable row level security;

create policy platform_select on public.platform_settings for select to authenticated using (true);
create policy platform_update on public.platform_settings for update to authenticated
  using ((select app.is_super_admin())) with check ((select app.is_super_admin()));

create policy subs_select on public.subscription_payments for select to authenticated
  using ((select app.is_super_admin())
         or (organization_id = (select app.current_org_id()) and (select app.is_admin())));

create policy audit_select on public.audit_logs for select to authenticated
  using ((select app.is_super_admin())
         or (organization_id = (select app.current_org_id()) and (select app.is_admin())));

create policy errors_select on public.error_logs for select to authenticated
  using ((select app.is_super_admin())
         or (organization_id = (select app.current_org_id()) and (select app.is_admin())));

drop policy org_select on public.organizations;
drop policy org_update on public.organizations;
create policy org_select on public.organizations for select to authenticated
  using (id = (select app.current_org_id()) or (select app.is_super_admin()));
create policy org_update on public.organizations for update to authenticated
  using ((select app.is_super_admin()))
  with check ((select app.is_super_admin()));
-- el admin cambia el nombre de su ruta mediante RPC (no puede tocar su suscripción)

drop policy profiles_select on public.profiles;
drop policy profiles_update on public.profiles;
create policy profiles_select on public.profiles for select to authenticated
  using ((select app.is_super_admin())
         or (organization_id = (select app.current_org_id())
             and ((select app.is_admin()) or id = (select auth.uid()))));
create policy profiles_update on public.profiles for update to authenticated
  using ((select app.is_super_admin())
         or (organization_id = (select app.current_org_id()) and (select app.is_admin()) and role = 'cobrador'))
  with check ((select app.is_super_admin())
         or (organization_id = (select app.current_org_id()) and role = 'cobrador'));

drop policy settings_select on public.settings;
drop policy settings_update on public.settings;
create policy settings_select on public.settings for select to authenticated
  using (organization_id = (select app.current_org_id()) or (select app.is_super_admin()));
create policy settings_update on public.settings for update to authenticated
  using ((organization_id = (select app.current_org_id()) and (select app.is_admin())) or (select app.is_super_admin()))
  with check ((organization_id = (select app.current_org_id())) or (select app.is_super_admin()));

-- ===== RPC de sesión =====
create or replace function public.get_session_context() returns jsonb
language plpgsql security definer set search_path = '' as $$
declare
  v_p public.profiles%rowtype;
  v_o public.organizations%rowtype;
  v_level text;
  v_grace integer;
  v_today date;
  v_msg text;
begin
  select * into v_p from public.profiles where id = auth.uid();
  if not found then raise exception 'NO_AUTORIZADO'; end if;
  update public.profiles set last_seen_at = now() where id = v_p.id;

  if not v_p.is_active then
    return jsonb_build_object('role', v_p.role, 'access_level', 'blocked', 'message', 'Tu usuario está desactivado. Comunícate con tu administrador.');
  end if;
  if v_p.role = 'super_admin' then
    return jsonb_build_object('role', 'super_admin', 'full_name', v_p.full_name, 'username', v_p.username, 'access_level', 'full');
  end if;

  select * into v_o from public.organizations where id = v_p.organization_id;
  select coalesce(v_o.grace_days_override, grace_days) into v_grace from public.platform_settings;
  v_level := app.org_access_level(v_o.id);
  v_today := (now() at time zone v_o.timezone)::date;
  v_msg := case
    when v_o.suspended then 'El acceso a esta ruta está suspendido. Comunícate con soporte.'
    when v_level = 'blocked' then 'La suscripción venció y no se ha realizado el pago. Comunícate con soporte para reactivar el acceso.'
    when v_level = 'readonly' then 'La suscripción venció. Tienes hasta el ' || to_char(v_o.subscription_ends_at + v_grace, 'DD/MM/YYYY')
      || ' para pagar; mientras tanto la app está en modo solo lectura.'
    when v_o.subscription_ends_at is not null and v_o.subscription_ends_at - v_today <= 5 then
      'Tu suscripción vence el ' || to_char(v_o.subscription_ends_at, 'DD/MM/YYYY') || '.'
    end;

  return jsonb_build_object(
    'role', v_p.role, 'full_name', v_p.full_name, 'username', v_p.username,
    'organization', jsonb_build_object('id', v_o.id, 'name', v_o.name, 'code', v_o.code),
    'access_level', v_level,
    'subscription_ends_at', v_o.subscription_ends_at,
    'grace_ends_at', v_o.subscription_ends_at + v_grace,
    'days_left', v_o.subscription_ends_at - v_today,
    'message', v_msg);
end $$;

create or replace function public.log_error(p_message text, p_context jsonb default '{}'::jsonb,
  p_source text default 'frontend', p_level text default 'error', p_url text default null, p_user_agent text default null)
returns void language sql security definer set search_path = '' as $$
  insert into public.error_logs(organization_id, user_id, source, level, message, context, url, user_agent)
  select (select organization_id from public.profiles where id = auth.uid()), auth.uid(),
         case when p_source in ('frontend','database','edge') then p_source else 'frontend' end,
         case when p_level in ('error','warning','info') then p_level else 'error' end,
         left(coalesce(p_message, ''), 2000), coalesce(p_context, '{}'::jsonb),
         left(p_url, 500), left(p_user_agent, 500)
  where auth.uid() is not null;
$$;

create or replace function public.update_my_organization_name(p_name text) returns void
language plpgsql security definer set search_path = '' as $$
begin
  if not app.is_admin() then raise exception 'NO_AUTORIZADO'; end if;
  if coalesce(trim(p_name), '') = '' then raise exception 'NOMBRE_REQUERIDO'; end if;
  update public.organizations set name = trim(p_name) where id = app.current_org_id();
end $$;

-- ===== RPC del súper admin =====
create or replace function public.sa_overview()
returns table(organization_id uuid, name text, code text, admin_name text, admin_username text,
  collectors integer, active_collectors integer, active_clients integer, active_loans integer, overdue_loans integer,
  last_seen timestamptz, actions_7d integer, errors_7d integer, subscription_ends_at date,
  access_level text, days_left integer, monthly_amount numeric, subscription_exempt boolean, suspended boolean)
language plpgsql stable security definer set search_path = '' as $$
begin
  if not app.is_super_admin() then raise exception 'NO_AUTORIZADO'; end if;
  return query
  select o.id, o.name, o.code,
    (select p.full_name from public.profiles p where p.organization_id = o.id and p.role = 'admin' order by p.created_at limit 1),
    (select p.username from public.profiles p where p.organization_id = o.id and p.role = 'admin' order by p.created_at limit 1),
    (select count(*)::int from public.profiles p where p.organization_id = o.id and p.role = 'cobrador'),
    (select count(*)::int from public.profiles p where p.organization_id = o.id and p.role = 'cobrador' and p.is_active),
    (select count(distinct l.client_id)::int from public.loans l where l.organization_id = o.id and l.status in ('activo','en_mora')),
    (select count(*)::int from public.loans l where l.organization_id = o.id and l.status in ('activo','en_mora')),
    (select count(*)::int from public.loans l where l.organization_id = o.id and l.status = 'en_mora'),
    (select max(p.last_seen_at) from public.profiles p where p.organization_id = o.id),
    (select count(*)::int from public.audit_logs a where a.organization_id = o.id and a.created_at > now() - interval '7 days'),
    (select count(*)::int from public.error_logs e where e.organization_id = o.id and e.created_at > now() - interval '7 days'),
    o.subscription_ends_at,
    app.org_access_level(o.id),
    (o.subscription_ends_at - (now() at time zone o.timezone)::date)::int,
    app.subscription_amount(o.id),
    o.subscription_exempt,
    o.suspended
  from public.organizations o
  order by o.subscription_ends_at nulls last, o.name;
end $$;

create or replace function public.sa_register_subscription_payment(p_org uuid, p_months integer default 1,
  p_method text default 'efectivo', p_reference text default null, p_notes text default null,
  p_amount_override numeric default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_o public.organizations%rowtype;
  v_today date;
  v_start date;
  v_end date;
  v_list numeric;
  v_amount numeric;
  v_id uuid;
begin
  if not app.is_super_admin() then raise exception 'NO_AUTORIZADO'; end if;
  if p_months is null or p_months <= 0 then raise exception 'MESES_INVALIDOS'; end if;
  select * into v_o from public.organizations where id = p_org for update;
  if not found then raise exception 'RUTA_NO_ENCONTRADA'; end if;

  v_today := (now() at time zone v_o.timezone)::date;
  v_start := case when v_o.subscription_ends_at is not null and v_o.subscription_ends_at >= v_today
                  then v_o.subscription_ends_at + 1 else v_today end;
  v_end := (v_start + make_interval(months => p_months))::date - 1;
  v_list := case when v_o.subscription_exempt then 0 else v_o.subscription_price * p_months end;
  v_amount := coalesce(p_amount_override, app.subscription_amount(p_org) * p_months);

  insert into public.subscription_payments(organization_id, months, period_start, period_end, list_price,
    discount_amount, amount_charged, exempt, method, reference, notes, registered_by)
  values (p_org, p_months, v_start, v_end, v_list, greatest(v_list - v_amount, 0), v_amount,
    v_o.subscription_exempt, p_method, p_reference, p_notes, auth.uid())
  returning id into v_id;

  update public.organizations set subscription_ends_at = v_end, suspended = false, suspended_reason = null where id = p_org;

  perform app.notify_admins(p_org, 'suscripcion_renovada', 'Suscripción renovada',
    'Tu acceso está activo hasta el ' || to_char(v_end, 'DD/MM/YYYY'), jsonb_build_object('subscription_payment_id', v_id));
  return v_id;
end $$;

-- Usada solo por la función de servidor que crea usuarios
create or replace function public.org_access(p_org uuid) returns text
language sql stable security definer set search_path = '' as $$
  select app.org_access_level(p_org)
$$;

-- ===== Recordatorios de suscripción (8:00 a.m. Bogotá) =====
create or replace function app.subscription_reminders() returns void
language plpgsql security definer set search_path = '' as $$
declare
  r record;
  v_days int[];
  v_grace int;
begin
  select reminder_days, grace_days into v_days, v_grace from public.platform_settings;
  for r in
    select o.id, o.name, o.subscription_ends_at, coalesce(o.grace_days_override, v_grace) as grace,
           (o.subscription_ends_at - (now() at time zone o.timezone)::date) as left_days
    from public.organizations o
    where o.subscription_ends_at is not null and not o.suspended
  loop
    if r.left_days = any(v_days) then
      perform app.notify_admins(r.id, 'suscripcion_por_vencer', 'Tu suscripción está por vencer',
        'Vence el ' || to_char(r.subscription_ends_at, 'DD/MM/YYYY') || ' (' || r.left_days || ' día(s)).', '{}'::jsonb);
    elsif r.left_days = -1 then
      insert into public.notifications(organization_id, recipient_id, type, title, body)
      select r.id, p.id, 'suscripcion_vencida', 'Suscripción vencida',
        'La app queda en modo solo lectura hasta el ' || to_char(r.subscription_ends_at + r.grace, 'DD/MM/YYYY') || '.'
      from public.profiles p where p.organization_id = r.id and p.is_active;
      insert into public.notifications(organization_id, recipient_id, type, title, body, data)
      select r.id, p.id, 'ruta_vencida', 'Ruta con suscripción vencida', r.name || ' no ha renovado.',
        jsonb_build_object('organization_id', r.id)
      from public.profiles p where p.role = 'super_admin' and p.is_active;
    end if;
  end loop;
end $$;

-- notificaciones del súper admin no pertenecen a una organización
alter table public.notifications alter column organization_id drop not null;

select cron.schedule('recordatorios-suscripcion', '0 13 * * *', $$select app.subscription_reminders()$$);

-- ===== Permisos =====
revoke all on function public.get_session_context(), public.log_error(text, jsonb, text, text, text, text),
  public.update_my_organization_name(text), public.sa_overview(),
  public.sa_register_subscription_payment(uuid, integer, text, text, text, numeric),
  public.org_access(uuid) from public, anon;
grant execute on function public.get_session_context(), public.log_error(text, jsonb, text, text, text, text),
  public.update_my_organization_name(text), public.sa_overview(),
  public.sa_register_subscription_payment(uuid, integer, text, text, text, numeric) to authenticated;
revoke execute on function public.org_access(uuid) from authenticated;
grant execute on function public.org_access(uuid) to service_role;

revoke all on all functions in schema app from public;
grant execute on function app.current_org_id(), app.is_admin(), app.is_super_admin(), app.org_today(uuid),
  app.safe_uuid(text), app.can_see_client(uuid) to authenticated;
revoke all on all tables in schema public from anon;
