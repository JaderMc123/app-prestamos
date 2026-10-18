-- 19: la papelería es del cobrador (no entra a la caja de la ruta ni a la ganancia del admin)
-- Compatible con la app actual: solo cambia cómo se mueve la plata de la papelería.

create or replace function app._create_loan(
  p_org uuid, p_client uuid, p_collector uuid, p_principal numeric, p_interest_rate numeric,
  p_start date, p_due date, p_paperwork_fee numeric, p_disb_method public.payment_method,
  p_disb_account uuid, p_disb_amount numeric, p_renewed_from uuid, p_notes text, p_created_by uuid,
  p_frequency text default 'diario', p_count integer default null,
  p_paperwork_deduct boolean default false, p_imported boolean default false)
returns uuid
language plpgsql security definer set search_path = ''
as $fn$
declare
  v_set public.settings%rowtype;
  v_fee numeric(14,2) := coalesce(p_paperwork_fee, 0);
  v_freq text := coalesce(nullif(p_frequency, ''), 'diario');
  v_disb numeric(14,2) := coalesce(p_disb_amount, 0);
  v_cash_out numeric(14,2);
  v_due date := p_due;
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
  if v_fee < 0 then raise exception 'PAPELERIA_INVALIDA: la papelería no puede ser negativa'; end if;
  if p_count is not null and (p_count < 1 or p_count > 400) then
    raise exception 'CUOTAS_INVALIDAS: el número de cuotas debe estar entre 1 y 400';
  end if;
  if p_count is null and (v_due is null or v_due <= p_start) then
    raise exception 'FECHA_INVALIDA: la fecha límite debe ser posterior a la fecha de inicio';
  end if;

  select * into v_set from public.settings where organization_id = p_org;

  v_dates := app.loan_dates(p_collector, v_freq, p_start, v_due, p_count);
  v_n := coalesce(array_length(v_dates, 1), 0);
  if v_n = 0 then
    raise exception 'SIN_DIAS_DE_COBRO: no hay fechas de cobro entre la fecha de inicio y la fecha límite';
  end if;
  v_due := v_dates[v_n];

  v_interest := round(p_principal * p_interest_rate / 100, 2);
  v_base := p_principal + v_interest;
  v_round := coalesce(v_set.installment_rounding, 0);
  if v_round > 0 then
    v_per := floor(v_base / v_n / v_round) * v_round;
  end if;
  if v_round = 0 or v_per is null or v_per <= 0 then
    v_per := floor(v_base / v_n * 100) / 100;
  end if;

  if v_fee > 0 and p_paperwork_deduct and v_disb > 0 then
    if v_fee > v_disb then raise exception 'PAPELERIA_INVALIDA: la papelería es mayor que el dinero a entregar'; end if;
    v_disb := v_disb - v_fee;
  end if;
  -- Lo que sale de la caja: el cliente recibe v_disb y el cobrador se queda la papelería (es suya)
  v_cash_out := v_disb + case when v_fee > 0 and p_paperwork_deduct and coalesce(p_disb_amount, 0) > 0 and p_disb_method = 'efectivo' then v_fee else 0 end;

  if v_cash_out > 0 then
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
    if v_bal < v_cash_out then
      raise exception 'CAPITAL_INSUFICIENTE: saldo disponible %', app.money(v_bal);
    end if;
  end if;

  insert into public.loans(organization_id, client_id, collector_id, principal, interest_rate, interest_amount,
    paperwork_daily_fee, installments_count, installment_amount, daily_payment, total_to_pay,
    start_date, due_date, disbursement_method, disbursement_account_id, disbursed_amount,
    renewed_from_loan_id, notes, created_by, frequency, paperwork_fee, paperwork_status, paperwork_paid_at, imported)
  values (p_org, p_client, p_collector, p_principal, p_interest_rate, v_interest,
    0, v_n, v_per, v_per, v_base,
    p_start, v_due, p_disb_method,
    case when p_disb_method = 'transferencia' and v_disb > 0 then p_disb_account end, v_disb,
    p_renewed_from, p_notes, p_created_by, v_freq, v_fee,
    case when v_fee <= 0 then 'no_aplica'
         when p_paperwork_deduct and coalesce(p_disb_amount, 0) > 0 then 'descontada'
         else 'pendiente' end,
    case when v_fee > 0 and p_paperwork_deduct and coalesce(p_disb_amount, 0) > 0 then now() end,
    p_imported)
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
    values (v_loan, p_org, i, v_dates[i], 'regular', v_amt - v_int, v_int, 0);
  end loop;

  if v_cash_out > 0 then
    insert into public.capital_movements(organization_id, type, amount, wallet_collector_id, wallet_account_id, loan_id, note, created_by)
    values (p_org, 'desembolso', -v_cash_out, v_wc, v_wa, v_loan, 'Desembolso de préstamo', p_created_by);
  end if;

  return v_loan;
end $fn$;

create or replace function public.charge_paperwork(
  p_loan_id uuid, p_method public.payment_method default 'efectivo', p_account_id uuid default null,
  p_transfer_reference text default null, p_paid_at timestamptz default null, p_client_uuid uuid default null)
returns uuid
language plpgsql security definer set search_path = ''
as $fn$
declare
  v_org uuid := app.current_org_id();
  v_uid uuid := auth.uid();
  v_loan public.loans%rowtype;
  v_acc public.payment_accounts%rowtype;
  v_id uuid;
  v_wc uuid; v_wa uuid;
  v_status public.verification_status;
  v_ref text := nullif(trim(p_transfer_reference), '');
  v_client text;
begin
  if v_org is null then raise exception 'NO_AUTORIZADO'; end if;
  if p_client_uuid is not null then
    select id into v_id from public.payments where client_uuid = p_client_uuid and organization_id = v_org;
    if found then return v_id; end if;
  end if;

  select * into v_loan from public.loans where id = p_loan_id and organization_id = v_org for update;
  if not found then raise exception 'PRESTAMO_NO_ENCONTRADO'; end if;
  if not app.is_admin() and v_loan.collector_id <> v_uid then raise exception 'NO_AUTORIZADO'; end if;
  if v_loan.status in ('renovado','castigado') then raise exception 'PRESTAMO_CERRADO: el préstamo no está activo'; end if;
  if v_loan.paperwork_status <> 'pendiente' or v_loan.paperwork_fee <= 0 then
    raise exception 'PAPELERIA_NO_PENDIENTE: este préstamo no tiene papelería por cobrar';
  end if;

  if p_method = 'efectivo' then
    v_wc := v_loan.collector_id; v_wa := null; v_status := 'no_aplica';
  elsif p_method = 'transferencia' then
    select * into v_acc from public.payment_accounts where id = p_account_id and organization_id = v_org and is_active;
    if not found then raise exception 'CUENTA_INVALIDA: seleccione la cuenta que recibió la transferencia'; end if;
    if v_ref is not null and exists (select 1 from public.payments
        where payment_account_id = v_acc.id and transfer_reference = v_ref and not is_reversed) then
      raise exception 'REFERENCIA_DUPLICADA: ya existe un pago con ese comprobante';
    end if;
    v_wc := v_acc.collector_id; v_wa := v_acc.id; v_status := 'no_aplica';
  else
    raise exception 'METODO_INVALIDO';
  end if;

  insert into public.payments(organization_id, loan_id, collector_id, registered_by, amount, method,
    payment_account_id, transfer_reference, verification_status, paid_at, notes, client_uuid, concept)
  values (v_org, p_loan_id, v_loan.collector_id, v_uid, v_loan.paperwork_fee, p_method,
    case when p_method = 'transferencia' then v_acc.id end, v_ref, v_status,
    coalesce(p_paid_at, now()), 'Papelería', p_client_uuid, 'papeleria')
  returning id into v_id;

  -- La papelería es del cobrador: queda registrada pero no se suma a la caja que entrega al admin

  update public.loans set paperwork_status = 'cobrada', paperwork_paid_at = coalesce(p_paid_at, now()), paperwork_payment_id = v_id
  where id = p_loan_id;


  return v_id;
end $fn$;

create or replace function public.admin_overview()
returns jsonb
language plpgsql stable security definer set search_path = ''
as $fn$
declare
  v_org uuid := app.current_org_id();
  v_tz text;
  v_today date;
  v_start date;
begin
  if not app.is_admin() then raise exception 'NO_AUTORIZADO'; end if;
  select timezone into v_tz from public.organizations where id = v_org;
  v_today := app.org_today(v_org);
  v_start := (date_trunc('month', v_today) - interval '5 months')::date;

  return jsonb_build_object(
    'months', (
      select jsonb_agg(jsonb_build_object(
        'month', to_char(m, 'YYYY-MM'),
        'cobrado', coalesce((select sum(p.amount) from public.payments p
            where p.organization_id = v_org and not p.is_reversed and p.concept = 'cuota'
              and (p.paid_at at time zone v_tz)::date >= m and (p.paid_at at time zone v_tz)::date < m + interval '1 month'), 0),
        'prestado', coalesce((select sum(l.principal) from public.loans l
            where l.organization_id = v_org and not l.imported and l.start_date >= m and l.start_date < m + interval '1 month'), 0),
        'ganancia', coalesce((select sum(a.interest_part + a.paperwork_part + a.late_fee_part)
            from public.payment_allocations a join public.payments p on p.id = a.payment_id
            where a.organization_id = v_org and not p.is_reversed and p.concept <> 'saldo_anterior'
              and (p.paid_at at time zone v_tz)::date >= m and (p.paid_at at time zone v_tz)::date < m + interval '1 month'), 0)
      ) order by m)
      from generate_series(v_start, date_trunc('month', v_today)::date, interval '1 month') as g(m)
    ),
    'today_collected', coalesce((select sum(amount) from public.payments
        where organization_id = v_org and not is_reversed and concept = 'cuota' and (paid_at at time zone v_tz)::date = v_today), 0),
    'today_due', coalesce((select sum(i.amount_due - i.amount_paid) from public.loan_installments i
        join public.loans l on l.id = i.loan_id
        where l.organization_id = v_org and l.status in ('activo','en_mora') and i.due_date <= v_today), 0),
    'pending_transfers', (select count(*) from public.payments
        where organization_id = v_org and verification_status = 'pendiente' and not is_reversed),
    'active_loans', (select count(*) from public.loans where organization_id = v_org and status in ('activo','en_mora')),
    'overdue_loans', (select count(*) from public.loans where organization_id = v_org and status = 'en_mora'),
    'projected_profit', coalesce((select sum((i.interest_due - i.interest_paid) + (i.paperwork_due - i.paperwork_paid) + (i.late_fee_due - i.late_fee_paid))
        from public.loan_installments i join public.loans l on l.id = i.loan_id
        where l.organization_id = v_org and l.status in ('activo','en_mora')), 0),
    'collectors', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', p.id, 'full_name', p.full_name, 'username', p.username, 'is_active', p.is_active, 'last_seen_at', p.last_seen_at,
        'cash', app.wallet_balance(v_org, p.id, null),
        'collected_today', coalesce((select sum(x.amount) from public.payments x
            where x.collector_id = p.id and not x.is_reversed and x.concept = 'cuota' and (x.paid_at at time zone v_tz)::date = v_today), 0),
        'due_today', coalesce((select sum(i.amount_due - i.amount_paid) from public.loan_installments i
            join public.loans l on l.id = i.loan_id
            where l.collector_id = p.id and l.status in ('activo','en_mora') and i.due_date <= v_today), 0),
        'active_loans', (select count(*) from public.loans l where l.collector_id = p.id and l.status in ('activo','en_mora'))
      ) order by p.full_name), '[]'::jsonb)
      from public.profiles p where p.organization_id = v_org and p.role = 'cobrador'
    )
  );
end $fn$;

-- Papelerías ya cobradas: se sacan de la caja de la ruta para que el cuadre no se las pida al cobrador
insert into public.capital_movements(organization_id, type, amount, wallet_collector_id, wallet_account_id, loan_id, payment_id, note, created_by)
select m.organization_id, 'ajuste', -m.amount, m.wallet_collector_id, m.wallet_account_id, m.loan_id, m.payment_id, 'Papelería del cobrador (no va a la caja de la ruta)', null
from public.capital_movements m
join public.payments p on p.id = m.payment_id
where m.type = 'cobro' and p.concept = 'papeleria' and not p.is_reversed
  and not exists (select 1 from public.capital_movements x where x.payment_id = m.payment_id and x.type = 'ajuste');

-- Papelerías descontadas del desembolso: el cobrador se quedó con ellas, así que su caja baja ese valor
insert into public.capital_movements(organization_id, type, amount, wallet_collector_id, wallet_account_id, loan_id, note, created_by)
select l.organization_id, 'ajuste', -l.paperwork_fee, l.collector_id, null, l.id, 'Papelería descontada: es del cobrador', null
from public.loans l
where l.paperwork_status = 'descontada' and l.paperwork_fee > 0 and l.disbursement_method = 'efectivo'
  and not exists (select 1 from public.capital_movements x where x.loan_id = l.id and x.type = 'ajuste' and x.note like 'Papelería descontada%');

-- Sueldos de los cobradores: valor y frecuencia en costos fijos (uno por cobrador)
create unique index if not exists fixed_costs_salary_uniq on public.fixed_costs(collector_id) where name = 'Sueldo';
