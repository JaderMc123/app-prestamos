-- ===== Funciones auxiliares =====
create or replace function app.current_org_id() returns uuid
language sql stable security definer set search_path = '' as $$
  select organization_id from public.profiles where id = auth.uid() and is_active
$$;

create or replace function app.is_admin() returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (select 1 from public.profiles where id = auth.uid() and role = 'admin' and is_active)
$$;

create or replace function app.org_today(p_org uuid) returns date
language sql stable security definer set search_path = '' as $$
  select (now() at time zone coalesce((select timezone from public.organizations where id = p_org), 'America/Bogota'))::date
$$;

create or replace function app.safe_uuid(p text) returns uuid
language plpgsql immutable set search_path = '' as $$
begin
  return p::uuid;
exception when others then
  return null;
end $$;

-- Un cobrador ve un cliente si tiene (o tuvo) un préstamo con él, o si lo creó y aún no tiene préstamos
create or replace function app.can_see_client(p_client uuid) returns boolean
language sql stable security definer set search_path = '' as $$
  select exists (
    select 1 from public.clients c
    where c.id = p_client
      and c.organization_id = app.current_org_id()
      and (
        app.is_admin()
        or exists (select 1 from public.loans l where l.client_id = c.id and l.collector_id = auth.uid())
        or (c.created_by = auth.uid() and not exists (select 1 from public.loans l2 where l2.client_id = c.id))
      )
  )
$$;

create or replace function app.notify(p_org uuid, p_recipient uuid, p_type text, p_title text, p_body text, p_data jsonb default '{}'::jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into public.notifications(organization_id, recipient_id, type, title, body, data)
  values (p_org, p_recipient, p_type, p_title, p_body, coalesce(p_data, '{}'::jsonb));
$$;

create or replace function app.notify_admins(p_org uuid, p_type text, p_title text, p_body text, p_data jsonb default '{}'::jsonb)
returns void language sql security definer set search_path = '' as $$
  insert into public.notifications(organization_id, recipient_id, type, title, body, data)
  select p_org, p.id, p_type, p_title, p_body, coalesce(p_data, '{}'::jsonb)
  from public.profiles p
  where p.organization_id = p_org and p.role = 'admin' and p.is_active;
$$;

create or replace function app.money(p numeric) returns text
language sql immutable set search_path = '' as $$
  select '$' || to_char(p, 'FM999G999G999G990')
$$;

revoke all on all functions in schema app from public;
grant execute on function app.current_org_id(), app.is_admin(), app.org_today(uuid),
  app.safe_uuid(text), app.can_see_client(uuid) to authenticated;

-- ===== Alta de usuarios =====
-- Admin: se registra solo y se le crea su organización.
-- Cobrador: lo crea el admin desde una función de servidor que fija app_metadata (role, organization_id).
create or replace function app.handle_new_user() returns trigger
language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid;
begin
  if (new.raw_app_meta_data->>'role') = 'cobrador'
     and app.safe_uuid(new.raw_app_meta_data->>'organization_id') is not null then
    v_org := (new.raw_app_meta_data->>'organization_id')::uuid;
    insert into public.profiles(id, organization_id, full_name, username, phone, role)
    values (new.id, v_org,
            coalesce(new.raw_user_meta_data->>'full_name', new.raw_app_meta_data->>'username', new.email),
            new.raw_app_meta_data->>'username',
            new.raw_user_meta_data->>'phone',
            'cobrador');
    insert into public.collection_schedules(collector_id, organization_id) values (new.id, v_org);
  else
    insert into public.organizations(name)
    values (coalesce(nullif(trim(new.raw_user_meta_data->>'organization_name'), ''), 'Mi organización'))
    returning id into v_org;
    insert into public.settings(organization_id) values (v_org);
    insert into public.profiles(id, organization_id, full_name, phone, role, can_view_total_capital)
    values (new.id, v_org, coalesce(new.raw_user_meta_data->>'full_name', new.email),
            new.raw_user_meta_data->>'phone', 'admin', true);
  end if;
  return new;
end $$;

create trigger on_auth_user_created after insert on auth.users
  for each row execute function app.handle_new_user();

-- ===== Gasto -> movimiento de capital + alerta =====
create or replace function app.on_expense_insert() returns trigger
language plpgsql security definer set search_path = '' as $$
begin
  insert into public.capital_movements(organization_id, type, amount, wallet_collector_id, wallet_account_id, expense_id, note, created_by)
  values (new.organization_id, 'gasto', -new.amount,
          case when new.kind = 'eventual_cobrador' then new.collector_id end,
          null, new.id, new.category, new.created_by);
  if new.kind = 'eventual_cobrador' then
    perform app.notify_admins(new.organization_id, 'gasto_cobrador', 'Nuevo gasto del cobrador',
      coalesce((select full_name from public.profiles where id = new.collector_id), 'Cobrador')
        || ' registró ' || new.category || ': ' || app.money(new.amount),
      jsonb_build_object('expense_id', new.id, 'collector_id', new.collector_id));
  end if;
  return new;
end $$;
create trigger trg_expense_insert after insert on public.expenses
  for each row execute function app.on_expense_insert();

-- ===== RLS =====
alter table public.organizations enable row level security;
alter table public.profiles enable row level security;
alter table public.settings enable row level security;
alter table public.collection_schedules enable row level security;
alter table public.payment_accounts enable row level security;
alter table public.clients enable row level security;
alter table public.loans enable row level security;
alter table public.loan_installments enable row level security;
alter table public.collection_logs enable row level security;
alter table public.client_assignment_history enable row level security;
alter table public.payments enable row level security;
alter table public.payment_allocations enable row level security;
alter table public.fixed_costs enable row level security;
alter table public.expenses enable row level security;
alter table public.cash_closures enable row level security;
alter table public.capital_movements enable row level security;
alter table public.notifications enable row level security;
alter table public.push_subscriptions enable row level security;

-- organizations
create policy org_select on public.organizations for select to authenticated
  using (id = (select app.current_org_id()));
create policy org_update on public.organizations for update to authenticated
  using (id = (select app.current_org_id()) and (select app.is_admin()))
  with check (id = (select app.current_org_id()));

-- profiles
create policy profiles_select on public.profiles for select to authenticated
  using (organization_id = (select app.current_org_id())
         and ((select app.is_admin()) or id = (select auth.uid())));
create policy profiles_update on public.profiles for update to authenticated
  using (organization_id = (select app.current_org_id()) and (select app.is_admin()))
  with check (organization_id = (select app.current_org_id()));

-- settings
create policy settings_select on public.settings for select to authenticated
  using (organization_id = (select app.current_org_id()));
create policy settings_update on public.settings for update to authenticated
  using (organization_id = (select app.current_org_id()) and (select app.is_admin()))
  with check (organization_id = (select app.current_org_id()));

-- collection_schedules
create policy sched_select on public.collection_schedules for select to authenticated
  using (organization_id = (select app.current_org_id())
         and ((select app.is_admin()) or collector_id = (select auth.uid())));
create policy sched_admin_write on public.collection_schedules for all to authenticated
  using (organization_id = (select app.current_org_id()) and (select app.is_admin()))
  with check (organization_id = (select app.current_org_id()) and (select app.is_admin()));

-- payment_accounts
create policy accounts_select on public.payment_accounts for select to authenticated
  using (organization_id = (select app.current_org_id())
         and ((select app.is_admin())
              or (is_active and (collector_id is null or collector_id = (select auth.uid())))));
create policy accounts_admin_insert on public.payment_accounts for insert to authenticated
  with check (organization_id = (select app.current_org_id()) and (select app.is_admin()));
create policy accounts_admin_update on public.payment_accounts for update to authenticated
  using (organization_id = (select app.current_org_id()) and (select app.is_admin()))
  with check (organization_id = (select app.current_org_id()));

-- clients
create policy clients_select on public.clients for select to authenticated
  using ((select app.can_see_client(id)));
create policy clients_insert on public.clients for insert to authenticated
  with check (organization_id = (select app.current_org_id()) and created_by = (select auth.uid()));
create policy clients_update on public.clients for update to authenticated
  using ((select app.can_see_client(id)))
  with check (organization_id = (select app.current_org_id()));
create policy clients_delete on public.clients for delete to authenticated
  using (organization_id = (select app.current_org_id()) and (select app.is_admin()));

-- client_assignment_history (solo lectura admin; escritura vía RPC)
create policy cah_select on public.client_assignment_history for select to authenticated
  using (organization_id = (select app.current_org_id()) and (select app.is_admin()));

-- loans / installments / payments / allocations: solo lectura; escritura vía RPC
create policy loans_select on public.loans for select to authenticated
  using (organization_id = (select app.current_org_id())
         and ((select app.is_admin()) or collector_id = (select auth.uid())));

create policy installments_select on public.loan_installments for select to authenticated
  using (organization_id = (select app.current_org_id())
         and ((select app.is_admin())
              or exists (select 1 from public.loans l where l.id = loan_id and l.collector_id = (select auth.uid()))));

create policy payments_select on public.payments for select to authenticated
  using (organization_id = (select app.current_org_id())
         and ((select app.is_admin()) or collector_id = (select auth.uid())));

create policy allocations_select on public.payment_allocations for select to authenticated
  using (organization_id = (select app.current_org_id())
         and ((select app.is_admin())
              or exists (select 1 from public.payments p where p.id = payment_id and p.collector_id = (select auth.uid()))));

-- collection_logs
create policy logs_select on public.collection_logs for select to authenticated
  using (organization_id = (select app.current_org_id())
         and ((select app.is_admin()) or collector_id = (select auth.uid())));
create policy logs_insert on public.collection_logs for insert to authenticated
  with check (organization_id = (select app.current_org_id())
              and collector_id = (select auth.uid())
              and exists (select 1 from public.loans l where l.id = loan_id
                          and l.organization_id = (select app.current_org_id())
                          and ((select app.is_admin()) or l.collector_id = (select auth.uid()))));

-- fixed_costs
create policy fixed_costs_select on public.fixed_costs for select to authenticated
  using (organization_id = (select app.current_org_id())
         and ((select app.is_admin()) or collector_id = (select auth.uid())));
create policy fixed_costs_admin_write on public.fixed_costs for all to authenticated
  using (organization_id = (select app.current_org_id()) and (select app.is_admin()))
  with check (organization_id = (select app.current_org_id()) and (select app.is_admin()));

-- expenses (inmutables)
create policy expenses_select on public.expenses for select to authenticated
  using (organization_id = (select app.current_org_id())
         and ((select app.is_admin()) or collector_id = (select auth.uid())));
create policy expenses_insert on public.expenses for insert to authenticated
  with check (organization_id = (select app.current_org_id())
              and created_by = (select auth.uid())
              and ((select app.is_admin())
                   or (kind = 'eventual_cobrador' and collector_id = (select auth.uid()))));

-- cash_closures
create policy closures_select on public.cash_closures for select to authenticated
  using (organization_id = (select app.current_org_id())
         and ((select app.is_admin()) or collector_id = (select auth.uid())));

-- capital_movements
create policy movements_select on public.capital_movements for select to authenticated
  using (organization_id = (select app.current_org_id())
         and ((select app.is_admin()) or wallet_collector_id = (select auth.uid())));

-- notifications
create policy notifications_select on public.notifications for select to authenticated
  using (recipient_id = (select auth.uid()));
create policy notifications_update on public.notifications for update to authenticated
  using (recipient_id = (select auth.uid()))
  with check (recipient_id = (select auth.uid()));
revoke update on public.notifications from authenticated;
grant update (read_at) on public.notifications to authenticated;

-- push_subscriptions
create policy push_all on public.push_subscriptions for all to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

-- Nada para anónimos
revoke all on all tables in schema public from anon;

-- Tiempo real para el monitoreo del admin
alter publication supabase_realtime add table public.payments, public.loans, public.collection_logs, public.notifications, public.expenses;
