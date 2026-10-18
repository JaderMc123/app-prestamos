-- La papelería ya no es configuración global: la define el cobrador en cada préstamo
alter table public.settings drop column paperwork_daily_fee;

-- La mora por defecto se calcula sobre el capital prestado
alter table public.settings alter column late_fee_base set default 'capital';
update public.settings set late_fee_base = 'capital';

create or replace function app._create_loan(
  p_org uuid, p_client uuid, p_collector uuid, p_principal numeric, p_interest_rate numeric,
  p_start date, p_due date, p_paperwork_fee numeric, p_disb_method public.payment_method,
  p_disb_account uuid, p_disb_amount numeric, p_renewed_from uuid, p_notes text, p_created_by uuid
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_set public.settings%rowtype;
  v_fee numeric(14,2) := p_paperwork_fee;
  v_interest numeric(14,2);
  v_base numeric(14,2);
  v_dates date[];
  v_n integer;
  v_per numeric(14,2);
  v_amt numeric(14,2);
  v_int numeric(14,2);
  v_int_acc numeric(14,2) := 0;
  v_round integer;
  v_wc uuid;
  v_wa uuid;
  v_acc public.payment_accounts%rowtype;
  v_bal numeric;
  v_loan uuid;
  i integer;
begin
  if p_principal is null or p_principal <= 0 then
    raise exception 'MONTO_INVALIDO: el monto debe ser mayor a 0';
  end if;
  if p_interest_rate is null or p_interest_rate < 0 then
    raise exception 'INTERES_INVALIDO: el interés no puede ser negativo';
  end if;
  if p_due is null or p_due <= p_start then
    raise exception 'FECHA_INVALIDA: la fecha límite debe ser posterior a la fecha de inicio';
  end if;
  if v_fee is null then
    raise exception 'PAPELERIA_REQUERIDA: ingrese el valor diario de la papelería';
  end if;
  if v_fee < 0 then raise exception 'PAPELERIA_INVALIDA'; end if;

  select * into v_set from public.settings where organization_id = p_org;

  select array_agg(d order by d) into v_dates from app.collection_dates(p_collector, p_start, p_due) as d;
  v_n := coalesce(array_length(v_dates, 1), 0);
  if v_n = 0 then
    raise exception 'SIN_DIAS_DE_COBRO: no hay días de cobro entre la fecha de inicio y la fecha límite';
  end if;

  v_interest := round(p_principal * p_interest_rate / 100, 2);
  v_base := p_principal + v_interest;
  v_round := coalesce(v_set.installment_rounding, 0);
  if v_round > 0 then
    v_per := floor(v_base / v_n / v_round) * v_round;
  end if;
  if v_round = 0 or v_per is null or v_per <= 0 then
    v_per := floor(v_base / v_n * 100) / 100;
  end if;

  if p_disb_amount > 0 then
    if p_disb_method = 'efectivo' then
      v_wc := p_collector; v_wa := null;
    elsif p_disb_method = 'transferencia' then
      select * into v_acc from public.payment_accounts
        where id = p_disb_account and organization_id = p_org and is_active;
      if not found then raise exception 'CUENTA_INVALIDA: cuenta de desembolso no válida'; end if;
      if v_acc.collector_id is distinct from p_collector and not app.is_admin() then
        raise exception 'NO_AUTORIZADO: no puede desembolsar desde esa cuenta';
      end if;
      v_wc := v_acc.collector_id; v_wa := v_acc.id;
    else
      raise exception 'METODO_INVALIDO';
    end if;
    v_bal := app.wallet_balance(p_org, v_wc, v_wa);
    if v_bal < p_disb_amount then
      raise exception 'CAPITAL_INSUFICIENTE: saldo disponible %', app.money(v_bal);
    end if;
  end if;

  insert into public.loans(organization_id, client_id, collector_id, principal, interest_rate, interest_amount,
    paperwork_daily_fee, installments_count, installment_amount, daily_payment, total_to_pay,
    start_date, due_date, disbursement_method, disbursement_account_id, disbursed_amount,
    renewed_from_loan_id, notes, created_by)
  values (p_org, p_client, p_collector, p_principal, p_interest_rate, v_interest,
    v_fee, v_n, v_per, v_per + v_fee, v_base + v_fee * v_n,
    p_start, p_due, p_disb_method,
    case when p_disb_method = 'transferencia' then p_disb_account end, p_disb_amount,
    p_renewed_from, p_notes, p_created_by)
  returning id into v_loan;

  for i in 1..v_n loop
    if i < v_n then
      v_amt := v_per;
      v_int := least(v_amt, round(v_amt * v_interest / v_base, 2));
    else
      v_amt := v_base - v_per * (v_n - 1);
      v_int := least(v_amt, v_interest - v_int_acc);
    end if;
    v_int_acc := v_int_acc + v_int;
    insert into public.loan_installments(loan_id, organization_id, number, due_date, kind,
      principal_due, interest_due, paperwork_due)
    values (v_loan, p_org, i, v_dates[i], 'regular', v_amt - v_int, v_int, v_fee);
  end loop;

  if p_disb_amount > 0 then
    insert into public.capital_movements(organization_id, type, amount, wallet_collector_id, wallet_account_id, loan_id, note, created_by)
    values (p_org, 'desembolso', -p_disb_amount, v_wc, v_wa, v_loan, 'Desembolso de préstamo', p_created_by);
  end if;

  return v_loan;
end $$;
revoke all on function app._create_loan(uuid, uuid, uuid, numeric, numeric, date, date, numeric, public.payment_method, uuid, numeric, uuid, text, uuid) from public;

-- Proceso diario: el recargo de mora puede calcularse sobre el capital prestado
create or replace function app.process_overdue_loans() returns void
language plpgsql security definer set search_path = '' as $$
declare
  r record;
  v_next integer;
  v_last date;
  v_amount numeric(14,2);
begin
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

  for r in
    select l.id, l.organization_id, l.collector_id, l.due_date, l.principal, l.interest_amount, c.full_name,
           s.late_fee_type, s.late_fee_value, s.late_fee_base, s.late_fee_grace_days,
           s.late_fee_recurring, s.late_fee_every_days,
           (now() at time zone o.timezone)::date as today
    from public.loans l
    join public.clients c on c.id = l.client_id
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
      if r.late_fee_base = 'capital' then
        v_amount := r.principal;
      elsif r.late_fee_base = 'saldo' then
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
      r.full_name || ': se sumó ' || app.money(v_amount) || ' por mora', jsonb_build_object('loan_id', r.id));
    perform app.notify_admins(r.organization_id, 'recargo_mora', 'Recargo por mora aplicado',
      r.full_name || ': se sumó ' || app.money(v_amount) || ' por mora', jsonb_build_object('loan_id', r.id, 'collector_id', r.collector_id));
  end loop;
end $$;
revoke all on function app.process_overdue_loans() from public;
