create or replace function app.audit_row() returns trigger
language plpgsql security definer set search_path = '' as $fn$
declare
  v_new jsonb; v_old jsonb; j jsonb;
  v_fields text[];
  v_org uuid;
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
  v_org := case when tg_table_name = 'organizations' then (j->>'id')::uuid else app.safe_uuid(j->>'organization_id') end;
  if tg_op = 'DELETE' and (tg_table_name = 'organizations' or not exists (select 1 from public.organizations where id = v_org)) then
    v_org := null;
  end if;
  insert into public.audit_logs(organization_id, actor_id, action, entity, entity_id, changed_fields)
  values (v_org, auth.uid(), lower(tg_op), tg_table_name, coalesce(j->>'id', j->>'organization_id'), v_fields);
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $fn$;

create or replace function app.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $fn$
declare
  v_role text := new.raw_app_meta_data->>'role';
  v_org uuid := app.safe_uuid(new.raw_app_meta_data->>'organization_id');
  v_name text := coalesce(new.raw_user_meta_data->>'full_name', new.raw_app_meta_data->>'username', new.email);
begin
  if v_role is null or exists (select 1 from public.profiles where id = new.id) then
    return new;
  end if;
  if v_role = 'super_admin' then
    insert into public.profiles(id, organization_id, full_name, username, phone, role, can_view_total_capital)
    values (new.id, null, v_name, new.raw_app_meta_data->>'username', new.raw_user_meta_data->>'phone', 'super_admin', true);
  elsif v_role in ('admin','cobrador') and v_org is not null then
    insert into public.profiles(id, organization_id, full_name, username, phone, role, can_view_total_capital)
    values (new.id, v_org, v_name, new.raw_app_meta_data->>'username', new.raw_user_meta_data->>'phone',
            v_role::public.user_role, v_role = 'admin');
    if v_role = 'cobrador' then
      insert into public.collection_schedules(collector_id, organization_id) values (new.id, v_org)
      on conflict (collector_id) do nothing;
    end if;
  end if;
  return new;
end $fn$;

drop trigger if exists on_auth_user_created on auth.users;
drop trigger if exists on_auth_user_role_set on auth.users;
create trigger on_auth_user_created after insert on auth.users
  for each row execute function app.handle_new_user();
create trigger on_auth_user_role_set after update of raw_app_meta_data on auth.users
  for each row execute function app.handle_new_user();
revoke all on function app.handle_new_user(), app.audit_row() from public;

delete from public.organizations o
where o.code = 'yoor' and not exists (select 1 from public.profiles p where p.organization_id = o.id);
