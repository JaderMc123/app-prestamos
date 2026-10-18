-- 18: refuerzos de seguridad e integridad (compatible con la app actual)

-- 1. El cobrador no puede quitarse la marca "No prestar más" del admin ni cambiar datos de control del cliente
create or replace function app.protect_client_fields()
returns trigger
language plpgsql security definer set search_path = ''
as $fn$
begin
  if auth.uid() is not null and not app.is_admin() and not app.is_super_admin() then
    new.blocked_by_admin := old.blocked_by_admin;
    new.blocked_reason := old.blocked_reason;
    new.blocked_at := old.blocked_at;
    new.organization_id := old.organization_id;
    new.created_by := old.created_by;
    new.document_number := old.document_number;
    new.client_uuid := old.client_uuid;
    -- La autorización de datos no se puede quitar desde el celular del cobrador
    new.data_consent_accepted := old.data_consent_accepted or new.data_consent_accepted;
  end if;
  return new;
end $fn$;

drop trigger if exists trg_clients_protect on public.clients;
create trigger trg_clients_protect before update on public.clients
for each row execute function app.protect_client_fields();

-- 2. La fecha de un pago no puede ser futura ni de hace más de 7 días (evita descuadres a propósito)
create or replace function app.clamp_payment_date()
returns trigger
language plpgsql set search_path = ''
as $fn$
begin
  if new.concept in ('cuota', 'papeleria')
     and (new.paid_at > now() + interval '5 minutes' or new.paid_at < now() - interval '7 days') then
    new.paid_at := now();
  end if;
  return new;
end $fn$;

drop trigger if exists trg_payments_clamp_date on public.payments;
create trigger trg_payments_clamp_date before insert on public.payments
for each row execute function app.clamp_payment_date();

-- 3. Nunca se saca de una caja más dinero del que tiene, aunque dos personas lo hagan al mismo tiempo
create or replace function app.guard_wallet()
returns trigger
language plpgsql security definer set search_path = ''
as $fn$
declare
  v_bal numeric;
begin
  if new.amount >= 0 or new.type not in ('desembolso', 'asignacion', 'devolucion', 'retiro') then
    return new;
  end if;
  perform pg_advisory_xact_lock(hashtextextended(new.organization_id::text || ':' || coalesce(new.wallet_collector_id::text, '-') || ':' || coalesce(new.wallet_account_id::text, '-'), 0));
  select coalesce(sum(amount), 0) into v_bal from public.capital_movements
  where organization_id = new.organization_id
    and wallet_collector_id is not distinct from new.wallet_collector_id
    and wallet_account_id is not distinct from new.wallet_account_id;
  if v_bal + new.amount < 0 then
    raise exception 'CAPITAL_INSUFICIENTE: saldo disponible %', app.money(v_bal);
  end if;
  return new;
end $fn$;

drop trigger if exists trg_capital_guard_wallet on public.capital_movements;
create trigger trg_capital_guard_wallet before insert on public.capital_movements
for each row execute function app.guard_wallet();

-- 4. Límite de registros de error por usuario (evita llenar la base de datos)
create or replace function public.log_error(p_message text, p_context jsonb default '{}'::jsonb,
  p_source text default 'frontend', p_level text default 'error', p_url text default null, p_user_agent text default null)
returns void
language sql security definer set search_path = ''
as $fn$
  insert into public.error_logs(organization_id, user_id, source, level, message, context, url, user_agent)
  select (select organization_id from public.profiles where id = auth.uid()), auth.uid(),
         case when p_source in ('frontend','database','edge') then p_source else 'frontend' end,
         case when p_level in ('error','warning','info') then p_level else 'error' end,
         left(coalesce(p_message, ''), 2000),
         case when length(coalesce(p_context, '{}'::jsonb)::text) > 8000 then '{"recortado":true}'::jsonb else coalesce(p_context, '{}'::jsonb) end,
         left(p_url, 500), left(p_user_agent, 500)
  where auth.uid() is not null
    and (select count(*) from public.error_logs e where e.user_id = auth.uid() and e.created_at > now() - interval '1 hour') < 120;
$fn$;

-- 5. Limpieza automática: errores de más de 90 días y notificaciones leídas de más de 120 días
create or replace function app.cleanup_logs()
returns void
language sql security definer set search_path = ''
as $fn$
  delete from public.error_logs where created_at < now() - interval '90 days';
  delete from public.notifications where read_at is not null and created_at < now() - interval '120 days';
$fn$;
select cron.schedule('limpieza-registros', '30 8 * * 0', $cron$select app.cleanup_logs()$cron$);

-- 6. Permisos: nada para usuarios sin sesión; solo los usuarios con sesión ejecutan funciones
revoke all on all tables in schema public from anon;
revoke execute on all functions in schema public from public, anon;
grant execute on all functions in schema public to authenticated, service_role;
revoke execute on function public.push_config() from authenticated;
revoke execute on function public.org_access(uuid) from authenticated;
alter default privileges in schema public revoke execute on functions from public;
alter default privileges in schema public revoke all on tables from anon;
alter default privileges in schema public grant execute on functions to authenticated, service_role;

revoke all on function app.protect_client_fields(), app.clamp_payment_date(), app.guard_wallet(), app.cleanup_logs() from public, anon, authenticated;
