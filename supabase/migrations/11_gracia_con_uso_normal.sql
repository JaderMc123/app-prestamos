-- full = al día · grace = vencida pero dentro de la gracia (uso normal con aviso)
-- readonly = gracia terminada (solo lectura) · blocked = suspendida manualmente por el súper admin
create or replace function app.org_access_level(p_org uuid) returns text
language sql stable security definer set search_path = '' as $$
  select case
    when o.id is null then 'blocked'
    when o.suspended then 'blocked'
    when o.subscription_ends_at is null then 'full'
    when (now() at time zone o.timezone)::date <= o.subscription_ends_at then 'full'
    when (now() at time zone o.timezone)::date
         <= o.subscription_ends_at + coalesce(o.grace_days_override, ps.grace_days) then 'grace'
    else 'readonly' end
  from public.platform_settings ps
  left join public.organizations o on o.id = p_org
$$;

create or replace function app.guard_org_write() returns trigger
language plpgsql security definer set search_path = '' as $$
declare v_org uuid;
begin
  if auth.uid() is null or app.is_super_admin() then
    if tg_op = 'DELETE' then return old; end if;
    return new;
  end if;
  if tg_op = 'DELETE' then v_org := old.organization_id; else v_org := new.organization_id; end if;
  if app.org_access_level(v_org) not in ('full','grace') then
    raise exception 'SUSCRIPCION_VENCIDA: no se puede realizar ninguna operación hasta que se pague la suscripción';
  end if;
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;

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
    return jsonb_build_object('role', v_p.role, 'access_level', 'blocked',
      'message', 'Tu usuario está desactivado. Comunícate con tu administrador.');
  end if;
  if v_p.role = 'super_admin' then
    return jsonb_build_object('role', 'super_admin', 'full_name', v_p.full_name, 'username', v_p.username, 'access_level', 'full');
  end if;

  select * into v_o from public.organizations where id = v_p.organization_id;
  select coalesce(v_o.grace_days_override, grace_days) into v_grace from public.platform_settings;
  v_level := app.org_access_level(v_o.id);
  v_today := (now() at time zone v_o.timezone)::date;
  v_msg := case
    when v_level = 'blocked' then 'El acceso a esta ruta está suspendido. Comunícate con soporte.'
    when v_level = 'readonly' then 'La suscripción no ha sido pagada. La app está en modo solo lectura: no podrás registrar cobros, préstamos ni gastos hasta que se pague.'
    when v_level = 'grace' then 'La suscripción venció el ' || to_char(v_o.subscription_ends_at, 'DD/MM/YYYY')
      || '. Puedes seguir trabajando hasta el ' || to_char(v_o.subscription_ends_at + v_grace, 'DD/MM/YYYY')
      || '; después la app pasará a solo lectura.'
    when v_o.subscription_ends_at is not null and v_o.subscription_ends_at - v_today <= 5 then
      'Tu suscripción vence el ' || to_char(v_o.subscription_ends_at, 'DD/MM/YYYY') || '.'
    end;

  return jsonb_build_object(
    'role', v_p.role, 'full_name', v_p.full_name, 'username', v_p.username,
    'organization', jsonb_build_object('id', v_o.id, 'name', v_o.name, 'code', v_o.code),
    'access_level', v_level,
    'can_write', v_level in ('full','grace'),
    'subscription_ends_at', v_o.subscription_ends_at,
    'grace_ends_at', v_o.subscription_ends_at + v_grace,
    'days_left', v_o.subscription_ends_at - v_today,
    'message', v_msg);
end $$;

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
        'Puedes seguir trabajando hasta el ' || to_char(r.subscription_ends_at + r.grace, 'DD/MM/YYYY')
        || '. Después la app pasará a solo lectura.'
      from public.profiles p where p.organization_id = r.id and p.is_active;
      insert into public.notifications(organization_id, recipient_id, type, title, body, data)
      select null, p.id, 'ruta_vencida', 'Ruta con suscripción vencida', r.name || ' entró en días de gracia.',
        jsonb_build_object('organization_id', r.id)
      from public.profiles p where p.role = 'super_admin' and p.is_active;
    elsif r.left_days = -(r.grace + 1) then
      insert into public.notifications(organization_id, recipient_id, type, title, body)
      select r.id, p.id, 'solo_lectura', 'App en modo solo lectura',
        'No podrás registrar cobros, préstamos ni gastos hasta que se pague la suscripción.'
      from public.profiles p where p.organization_id = r.id and p.is_active;
      insert into public.notifications(organization_id, recipient_id, type, title, body, data)
      select null, p.id, 'ruta_solo_lectura', 'Ruta en solo lectura', r.name || ' terminó los días de gracia sin pagar.',
        jsonb_build_object('organization_id', r.id)
      from public.profiles p where p.role = 'super_admin' and p.is_active;
    end if;
  end loop;
end $$;

revoke all on function app.subscription_reminders(), app.guard_org_write(), app.org_access_level(uuid) from public;
