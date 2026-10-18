-- ===== Storage =====
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types) values
  ('client-documents', 'client-documents', false, 5242880, array['image/jpeg','image/png','image/webp','application/pdf']),
  ('receipts', 'receipts', false, 5242880, array['image/jpeg','image/png','image/webp','application/pdf'])
on conflict (id) do nothing;

-- client-documents: {organization_id}/{client_id}/archivo  (cédula y autorización de datos)
create policy "docs_select" on storage.objects for select to authenticated
  using (bucket_id = 'client-documents'
         and (storage.foldername(name))[1] = (select app.current_org_id())::text
         and app.can_see_client(app.safe_uuid((storage.foldername(name))[2])));
create policy "docs_insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'client-documents'
         and (storage.foldername(name))[1] = (select app.current_org_id())::text
         and app.can_see_client(app.safe_uuid((storage.foldername(name))[2])));
create policy "docs_update_admin" on storage.objects for update to authenticated
  using (bucket_id = 'client-documents'
         and (storage.foldername(name))[1] = (select app.current_org_id())::text
         and (select app.is_admin()));
create policy "docs_delete_admin" on storage.objects for delete to authenticated
  using (bucket_id = 'client-documents'
         and (storage.foldername(name))[1] = (select app.current_org_id())::text
         and (select app.is_admin()));

-- receipts: {organization_id}/{collector_id}/archivo  (comprobantes de transferencias y gastos)
create policy "receipts_select" on storage.objects for select to authenticated
  using (bucket_id = 'receipts'
         and (storage.foldername(name))[1] = (select app.current_org_id())::text
         and ((select app.is_admin()) or (storage.foldername(name))[2] = (select auth.uid())::text));
create policy "receipts_insert" on storage.objects for insert to authenticated
  with check (bucket_id = 'receipts'
         and (storage.foldername(name))[1] = (select app.current_org_id())::text
         and ((select app.is_admin()) or (storage.foldername(name))[2] = (select auth.uid())::text));

-- ===== Procesos diarios =====
-- 18:00 Bogotá: alerta de cuotas no pagadas sin observación
create or replace function app.notify_missed_payments() returns void
language plpgsql security definer set search_path = '' as $$
declare r record;
begin
  for r in
    select l.organization_id, l.collector_id, count(*) as n,
           jsonb_agg(jsonb_build_object('loan_id', l.id, 'client', c.full_name)) as items
    from public.loans l
    join public.clients c on c.id = l.client_id
    join public.organizations o on o.id = l.organization_id
    where l.status in ('activo','en_mora')
      and exists (select 1 from public.loan_installments i
                  where i.loan_id = l.id and i.amount_paid < i.amount_due
                    and i.due_date <= (now() at time zone o.timezone)::date)
      and exists (select 1 from public.loan_installments i2
                  where i2.loan_id = l.id and i2.due_date = (now() at time zone o.timezone)::date)
      and not exists (select 1 from public.payments p
                      where p.loan_id = l.id and not p.is_reversed
                        and (p.paid_at at time zone o.timezone)::date = (now() at time zone o.timezone)::date)
      and not exists (select 1 from public.collection_logs cl
                      where cl.loan_id = l.id and cl.log_date = (now() at time zone o.timezone)::date)
    group by l.organization_id, l.collector_id
  loop
    perform app.notify(r.organization_id, r.collector_id, 'cuotas_no_pagadas', 'Cuotas sin pagar hoy',
      r.n || ' cliente(s) no pagaron hoy. Registra una observación.', jsonb_build_object('items', r.items));
    perform app.notify_admins(r.organization_id, 'cuotas_no_pagadas_ruta', 'Cobros pendientes en ruta',
      coalesce((select full_name from public.profiles where id = r.collector_id), 'Cobrador')
        || ': ' || r.n || ' cuota(s) sin pagar hoy',
      jsonb_build_object('collector_id', r.collector_id, 'items', r.items));
  end loop;
end $$;

-- 00:05 Bogotá: marca mora, agrega papelería diaria en mora y recargo (si está habilitado)
create or replace function app.process_overdue_loans() returns void
language plpgsql security definer set search_path = '' as $$
declare
  r record;
  v_next integer;
  v_last date;
  v_amount numeric(14,2);
begin
  -- 1. Pasar a mora los vencidos con saldo
  for r in
    select l.id, l.organization_id, l.collector_id, c.full_name
    from public.loans l
    join public.clients c on c.id = l.client_id
    join public.organizations o on o.id = l.organization_id
    where l.status = 'activo'
      and l.due_date < (now() at time zone o.timezone)::date
      and exists (select 1 from public.loan_installments i where i.loan_id = l.id and i.amount_paid < i.amount_due)
  loop
    update public.loans set status = 'en_mora' where id = r.id;
    perform app.notify(r.organization_id, r.collector_id, 'prestamo_en_mora', 'Préstamo en mora',
      r.full_name || ' pasó la fecha límite', jsonb_build_object('loan_id', r.id));
    perform app.notify_admins(r.organization_id, 'prestamo_en_mora', 'Préstamo en mora',
      r.full_name || ' pasó la fecha límite', jsonb_build_object('loan_id', r.id, 'collector_id', r.collector_id));
  end loop;

  -- 2. Papelería diaria durante la mora (solo en días de cobro del cobrador)
  for r in
    select l.id, l.organization_id, l.collector_id, l.paperwork_daily_fee,
           (now() at time zone o.timezone)::date as today
    from public.loans l join public.organizations o on o.id = l.organization_id
    where l.status = 'en_mora' and l.paperwork_daily_fee > 0
  loop
    if extract(isodow from r.today)::smallint = any (
         coalesce((select weekdays from public.collection_schedules where collector_id = r.collector_id),
                  '{1,2,3,4,5,6}'::smallint[])) then
      select coalesce(max(number), 0) + 1 into v_next from public.loan_installments where loan_id = r.id;
      insert into public.loan_installments(loan_id, organization_id, number, due_date, kind, paperwork_due)
      values (r.id, r.organization_id, v_next, r.today, 'papeleria_mora', r.paperwork_daily_fee)
      on conflict do nothing;
    end if;
  end loop;

  -- 3. Recargo por mora (configurable; desactivado por defecto)
  for r in
    select l.id, l.organization_id, l.collector_id, l.due_date, l.principal, l.interest_amount,
           s.late_fee_type, s.late_fee_value, s.late_fee_base, s.late_fee_grace_days,
           s.late_fee_recurring, s.late_fee_every_days,
           (now() at time zone o.timezone)::date as today
    from public.loans l
    join public.settings s on s.organization_id = l.organization_id
    join public.organizations o on o.id = l.organization_id
    where l.status = 'en_mora' and s.late_fee_enabled
  loop
    continue when (r.today - r.due_date) <= r.late_fee_grace_days;
    select max(due_date) into v_last from public.loan_installments where loan_id = r.id and kind = 'recargo_mora';
    if v_last is not null then
      continue when not r.late_fee_recurring;
      continue when r.today < v_last + r.late_fee_every_days;
    end if;

    if r.late_fee_type = 'fijo' then
      v_amount := r.late_fee_value;
    else
      if r.late_fee_base = 'saldo' then
        select coalesce(sum(amount_due - amount_paid), 0) into v_amount from public.loan_installments where loan_id = r.id;
      else
        v_amount := r.principal + r.interest_amount;
      end if;
      v_amount := round(v_amount * r.late_fee_value / 100, 2);
    end if;
    continue when v_amount <= 0;

    select coalesce(max(number), 0) + 1 into v_next from public.loan_installments where loan_id = r.id;
    insert into public.loan_installments(loan_id, organization_id, number, due_date, kind, late_fee_due)
    values (r.id, r.organization_id, v_next, r.today, 'recargo_mora', v_amount)
    on conflict do nothing;

    perform app.notify(r.organization_id, r.collector_id, 'recargo_mora', 'Recargo por mora aplicado',
      'Se agregó un recargo de ' || app.money(v_amount), jsonb_build_object('loan_id', r.id));
  end loop;
end $$;

revoke all on function app.notify_missed_payments(), app.process_overdue_loans() from public;

create extension if not exists pg_cron;

select cron.schedule('alerta-cuotas-no-pagadas', '0 23 * * *', $$select app.notify_missed_payments()$$);
select cron.schedule('procesar-mora-diaria', '5 5 * * *', $$select app.process_overdue_loans()$$);
