-- 17: papelería única, frecuencias de cobro, importación y notificaciones push

alter table public.loans
  add column if not exists frequency text not null default 'diario',
  add column if not exists paperwork_fee numeric(14,2) not null default 0,
  add column if not exists paperwork_status text not null default 'no_aplica',
  add column if not exists paperwork_paid_at timestamptz,
  add column if not exists paperwork_payment_id uuid references public.payments(id) on delete set null,
  add column if not exists imported boolean not null default false;

alter table public.loans alter column paperwork_daily_fee set default 0;

do $do$ begin
  alter table public.loans add constraint loans_frequency_chk check (frequency in ('diario','quincenal','mensual'));
exception when duplicate_object then null; end $do$;
do $do$ begin
  alter table public.loans add constraint loans_paperwork_status_chk check (paperwork_status in ('no_aplica','pendiente','cobrada','descontada'));
exception when duplicate_object then null; end $do$;

alter table public.payments add column if not exists concept text not null default 'cuota';
do $do$ begin
  alter table public.payments add constraint payments_concept_chk check (concept in ('cuota','papeleria','saldo_anterior','renovacion'));
exception when duplicate_object then null; end $do$;
update public.payments set concept = 'renovacion' where method = 'renovacion' and concept = 'cuota';

alter table public.settings
  add column if not exists default_interest_rate numeric(6,2) not null default 20,
  add column if not exists frequencies text[] not null default '{diario}';

update public.loans l set
  paperwork_fee = l.paperwork_daily_fee,
  paperwork_status = case when exists (select 1 from public.loan_installments i where i.loan_id = l.id and i.paperwork_paid > 0)
                          then 'cobrada' else 'pendiente' end
where l.paperwork_daily_fee > 0;

delete from public.payment_allocations a using public.loan_installments i
where a.installment_id = i.id and i.kind = 'papeleria_mora' and i.amount_paid = 0;
delete from public.loan_installments where kind = 'papeleria_mora' and amount_paid = 0;
update public.loan_installments set paperwork_due = paperwork_paid where paperwork_due <> paperwork_paid;

update public.loans l set
  paperwork_daily_fee = 0,
  daily_payment = l.installment_amount,
  total_to_pay = coalesce((select sum(i.principal_due + i.interest_due) from public.loan_installments i where i.loan_id = l.id and i.kind = 'regular'), l.total_to_pay);

create or replace function app.loan_dates(p_collector uuid, p_freq text, p_start date, p_due date, p_count integer)
returns date[]
language plpgsql stable security definer set search_path = ''
as $fn$
declare
  v date[] := '{}';
  m date;
  c date;
  k integer := 1;
begin
  if p_freq = 'diario' then
    if p_count is not null then
      select coalesce(array_agg(x order by x), '{}') into v
      from (select x from app.collection_dates(p_collector, p_start, p_start + p_count * 7 + 7) as x order by x limit p_count) s;
    else
      select coalesce(array_agg(x order by x), '{}') into v from app.collection_dates(p_collector, p_start, p_due) as x;
    end if;
  elsif p_freq = 'quincenal' then
    m := date_trunc('month', p_start)::date;
    while k <= 400 loop
      foreach c in array array[m + 14, least(m + 29, (m + interval '1 month' - interval '1 day')::date)] loop
        if c > p_start and (p_count is not null or c <= p_due) then v := v || c; end if;
      end loop;
      exit when p_count is not null and coalesce(array_length(v, 1), 0) >= p_count;
      exit when p_count is null and m > p_due;
      m := (m + interval '1 month')::date;
      k := k + 1;
    end loop;
    if p_count is not null then v := v[1:p_count]; end if;
  elsif p_freq = 'mensual' then
    while k <= 400 loop
      c := (p_start + make_interval(months => k))::date;
      exit when p_count is not null and k > p_count;
      exit when p_count is null and c > p_due;
      v := v || c;
      k := k + 1;
    end loop;
  else
    raise exception 'FRECUENCIA_INVALIDA: use diario, quincenal o mensual';
  end if;
  return v;
end $fn$;

drop function if exists app._create_loan(uuid, uuid, uuid, numeric, numeric, date, date, numeric, public.payment_method, uuid, numeric, uuid, text, uuid);

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

  if v_disb > 0 then
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
    if v_bal < v_disb then
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

  if v_disb > 0 then
    insert into public.capital_movements(organization_id, type, amount, wallet_collector_id, wallet_account_id, loan_id, note, created_by)
    values (p_org, 'desembolso', -v_disb, v_wc, v_wa, v_loan, 'Desembolso de préstamo', p_created_by);
  end if;

  return v_loan;
end $fn$;

drop function if exists public.create_loan(uuid, numeric, numeric, date, date, uuid, numeric, public.payment_method, uuid, text);

create or replace function public.create_loan(
  p_client_id uuid, p_principal numeric, p_interest_rate numeric default null, p_due_date date default null,
  p_start_date date default null, p_collector_id uuid default null, p_paperwork_fee numeric default 0,
  p_disbursement_method public.payment_method default 'efectivo', p_disbursement_account_id uuid default null,
  p_notes text default null, p_frequency text default 'diario', p_installments integer default null,
  p_paperwork_deduct boolean default false)
returns uuid
language plpgsql security definer set search_path = ''
as $fn$
declare
  v_org uuid := app.current_org_id();
  v_uid uuid := auth.uid();
  v_collector uuid;
  v_set public.settings%rowtype;
  v_rate numeric;
  v_freq text := coalesce(nullif(p_frequency, ''), 'diario');
begin
  if v_org is null then raise exception 'NO_AUTORIZADO'; end if;
  select * into v_set from public.settings where organization_id = v_org;
  v_collector := case when app.is_admin() then coalesce(p_collector_id, v_uid) else v_uid end;
  perform 1 from public.profiles where id = v_collector and organization_id = v_org and is_active;
  if not found then raise exception 'COBRADOR_INVALIDO'; end if;
  perform 1 from public.clients where id = p_client_id and organization_id = v_org;
  if not found then raise exception 'CLIENTE_NO_ENCONTRADO'; end if;
  if p_disbursement_method = 'renovacion' then raise exception 'METODO_INVALIDO'; end if;

  if app.is_admin() then
    v_rate := coalesce(p_interest_rate, v_set.default_interest_rate, 20);
  else
    v_rate := coalesce(v_set.default_interest_rate, 20);
    if not (v_freq = any (coalesce(v_set.frequencies, '{diario}'))) then
      raise exception 'FRECUENCIA_NO_PERMITIDA: el administrador no tiene activa esa frecuencia de cobro';
    end if;
  end if;

  return app._create_loan(v_org, p_client_id, v_collector, p_principal, v_rate,
    coalesce(p_start_date, app.org_today(v_org)), p_due_date, p_paperwork_fee,
    p_disbursement_method, p_disbursement_account_id, p_principal, null, p_notes, v_uid,
    v_freq, p_installments, coalesce(p_paperwork_deduct, false), false);
end $fn$;

drop function if exists public.renew_loan(uuid, numeric, numeric, date, numeric, public.payment_method, uuid, text);

create or replace function public.renew_loan(
  p_old_loan_id uuid, p_principal numeric, p_interest_rate numeric default null, p_due_date date default null,
  p_paperwork_fee numeric default 0, p_disbursement_method public.payment_method default 'efectivo',
  p_disbursement_account_id uuid default null, p_notes text default null,
  p_frequency text default null, p_installments integer default null, p_paperwork_deduct boolean default false)
returns uuid
language plpgsql security definer set search_path = ''
as $fn$
declare
  v_org uuid := app.current_org_id();
  v_uid uuid := auth.uid();
  v_old public.loans%rowtype;
  v_set public.settings%rowtype;
  v_rem numeric;
  v_new uuid;
  v_pay uuid;
  v_rate numeric;
  v_freq text;
begin
  if v_org is null then raise exception 'NO_AUTORIZADO'; end if;
  select * into v_old from public.loans where id = p_old_loan_id and organization_id = v_org for update;
  if not found then raise exception 'PRESTAMO_NO_ENCONTRADO'; end if;
  if not app.is_admin() and v_old.collector_id <> v_uid then raise exception 'NO_AUTORIZADO'; end if;
  if v_old.status not in ('activo','en_mora') then raise exception 'PRESTAMO_CERRADO'; end if;
  if p_disbursement_method = 'renovacion' then raise exception 'METODO_INVALIDO'; end if;

  select * into v_set from public.settings where organization_id = v_org;
  v_freq := coalesce(nullif(p_frequency, ''), v_old.frequency, 'diario');
  if app.is_admin() then
    v_rate := coalesce(p_interest_rate, v_set.default_interest_rate, 20);
  else
    v_rate := coalesce(v_set.default_interest_rate, 20);
    if not (v_freq = any (coalesce(v_set.frequencies, '{diario}'))) then
      raise exception 'FRECUENCIA_NO_PERMITIDA: el administrador no tiene activa esa frecuencia de cobro';
    end if;
  end if;

  select coalesce(sum(amount_due - amount_paid), 0) into v_rem from public.loan_installments where loan_id = p_old_loan_id;
  if p_principal < v_rem then
    raise exception 'MONTO_INSUFICIENTE: el nuevo préstamo debe cubrir el saldo pendiente de %', app.money(v_rem);
  end if;

  v_new := app._create_loan(v_org, v_old.client_id, v_old.collector_id, p_principal, v_rate,
    app.org_today(v_org), p_due_date, p_paperwork_fee, p_disbursement_method,
    p_disbursement_account_id, p_principal - v_rem, p_old_loan_id, p_notes, v_uid,
    v_freq, p_installments, coalesce(p_paperwork_deduct, false), false);

  if v_rem > 0 then
    insert into public.payments(organization_id, loan_id, collector_id, registered_by, amount, method, verification_status, notes, concept)
    values (v_org, p_old_loan_id, v_old.collector_id, v_uid, v_rem, 'renovacion', 'no_aplica', 'Saldo cubierto por renovación', 'renovacion')
    returning id into v_pay;
    perform app._apply_payment(p_old_loan_id, v_pay, v_rem);
  end if;

  update public.loans set status = 'renovado', closed_at = now() where id = p_old_loan_id;
  return v_new;
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
    v_wc := v_acc.collector_id; v_wa := v_acc.id; v_status := 'pendiente';
  else
    raise exception 'METODO_INVALIDO';
  end if;

  insert into public.payments(organization_id, loan_id, collector_id, registered_by, amount, method,
    payment_account_id, transfer_reference, verification_status, paid_at, notes, client_uuid, concept)
  values (v_org, p_loan_id, v_loan.collector_id, v_uid, v_loan.paperwork_fee, p_method,
    case when p_method = 'transferencia' then v_acc.id end, v_ref, v_status,
    coalesce(p_paid_at, now()), 'Papelería', p_client_uuid, 'papeleria')
  returning id into v_id;

  insert into public.capital_movements(organization_id, type, amount, wallet_collector_id, wallet_account_id, loan_id, payment_id, note, created_by)
  values (v_org, 'cobro', v_loan.paperwork_fee, v_wc, v_wa, p_loan_id, v_id, 'Papelería', v_uid);

  update public.loans set paperwork_status = 'cobrada', paperwork_paid_at = coalesce(p_paid_at, now()), paperwork_payment_id = v_id
  where id = p_loan_id;

  if p_method = 'transferencia' then
    select full_name into v_client from public.clients where id = v_loan.client_id;
    perform app.notify_admins(v_org, 'transferencia_pendiente', 'Transferencia por verificar',
      v_client || ': papelería de ' || app.money(v_loan.paperwork_fee) || ' a ' || v_acc.name,
      jsonb_build_object('payment_id', v_id, 'loan_id', p_loan_id, 'collector_id', v_loan.collector_id));
  end if;
  return v_id;
end $fn$;

create or replace function app._reverse_payment(p_payment uuid, p_reason text)
returns void
language plpgsql security definer set search_path = ''
as $fn$
declare
  v_p public.payments%rowtype;
  v_m public.capital_movements%rowtype;
  a record;
begin
  select * into v_p from public.payments where id = p_payment for update;
  if v_p.is_reversed then raise exception 'YA_REVERSADO: el pago ya fue reversado'; end if;
  if v_p.method = 'renovacion' then raise exception 'NO_PERMITIDO: no se puede reversar un pago de renovación'; end if;

  for a in select * from public.payment_allocations where payment_id = p_payment loop
    update public.loan_installments set
      principal_paid = principal_paid - a.principal_part,
      interest_paid  = interest_paid - a.interest_part,
      paperwork_paid = paperwork_paid - a.paperwork_part,
      late_fee_paid  = late_fee_paid - a.late_fee_part
    where id = a.installment_id;
    update public.loan_installments set
      status = case when amount_paid <= 0 then 'pendiente'::public.installment_status
                    when amount_paid >= amount_due then 'pagada'::public.installment_status
                    else 'parcial'::public.installment_status end
    where id = a.installment_id;
  end loop;

  update public.payments set is_reversed = true, reversed_at = now(),
    reversed_by = auth.uid(), reversal_reason = p_reason
  where id = p_payment;

  if v_p.concept = 'papeleria' then
    update public.loans set paperwork_status = 'pendiente', paperwork_paid_at = null, paperwork_payment_id = null
    where id = v_p.loan_id and paperwork_payment_id = p_payment;
  end if;

  select * into v_m from public.capital_movements where payment_id = p_payment and type = 'cobro' limit 1;
  if found then
    insert into public.capital_movements(organization_id, type, amount, wallet_collector_id, wallet_account_id, loan_id, payment_id, note, created_by)
    values (v_m.organization_id, 'reverso_cobro', -v_m.amount, v_m.wallet_collector_id, v_m.wallet_account_id,
            v_p.loan_id, p_payment, p_reason, auth.uid());
  end if;

  perform app.refresh_loan_status(v_p.loan_id);
end $fn$;

create or replace function app.process_overdue_loans()
returns void
language plpgsql security definer set search_path = ''
as $fn$
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
end $fn$;

create or replace function public.import_loans(p_rows jsonb, p_dry_run boolean default false)
returns jsonb
language plpgsql security definer set search_path = ''
as $fn$
declare
  v_org uuid := app.current_org_id();
  v_uid uuid := auth.uid();
  v_set public.settings%rowtype;
  v_out jsonb := '[]';
  v_count jsonb := '{}';
  r jsonb;
  n integer := 0;
  v_doc text; v_name text; v_barrio text; v_user text; v_freq text;
  v_amount numeric; v_rate numeric; v_paid numeric; v_cuotas integer;
  v_start date; v_due date;
  v_collector uuid; v_client uuid; v_loan uuid; v_pay uuid; v_total numeric;
  k text; c integer;
begin
  if not app.is_admin() then raise exception 'NO_AUTORIZADO'; end if;
  if jsonb_typeof(p_rows) <> 'array' then raise exception 'DATOS_INVALIDOS'; end if;
  if jsonb_array_length(p_rows) > 500 then raise exception 'DEMASIADAS_FILAS: máximo 500 filas por envío'; end if;
  select * into v_set from public.settings where organization_id = v_org;

  begin
    for r in select * from jsonb_array_elements(p_rows) loop
      n := n + 1;
      begin
        v_doc := upper(regexp_replace(coalesce(r->>'cedula', ''), '[^0-9A-Za-z]', '', 'g'));
        v_name := nullif(trim(coalesce(r->>'nombre', '')), '');
        v_barrio := nullif(trim(coalesce(r->>'barrio', '')), '');
        v_user := lower(nullif(trim(coalesce(r->>'cobrador', '')), ''));
        v_freq := lower(coalesce(nullif(trim(r->>'frecuencia'), ''), 'diario'));
        v_freq := case when v_freq like 'diar%' then 'diario' when v_freq like 'quinc%' then 'quincenal'
                       when v_freq like 'mens%' then 'mensual' else v_freq end;
        if length(v_doc) < 5 then raise exception 'Cédula inválida'; end if;
        if v_name is null then raise exception 'Falta el nombre'; end if;
        if v_barrio is null then raise exception 'Falta el barrio'; end if;
        if v_user is null then raise exception 'Falta el usuario del cobrador'; end if;
        if v_freq not in ('diario','quincenal','mensual') then raise exception 'Frecuencia inválida (diario, quincenal o mensual)'; end if;

        v_amount := nullif(r->>'monto', '')::numeric;
        if v_amount is null or v_amount <= 0 then raise exception 'Monto inválido'; end if;
        v_rate := coalesce(nullif(r->>'interes', '')::numeric, v_set.default_interest_rate, 20);
        if v_rate < 0 then raise exception 'Interés inválido'; end if;
        v_paid := coalesce(nullif(r->>'pagado', '')::numeric, 0);
        if v_paid < 0 then raise exception 'Valor pagado inválido'; end if;
        v_cuotas := nullif(r->>'cuotas', '')::integer;
        v_start := nullif(r->>'fecha_prestamo', '')::date;
        v_due := nullif(r->>'fecha_limite', '')::date;
        if v_start is null then raise exception 'Falta la fecha del préstamo'; end if;
        if v_due is null and v_cuotas is null then raise exception 'Falta la fecha límite o el número de cuotas'; end if;
        if v_due is not null then v_cuotas := null; end if;

        select id into v_collector from public.profiles
        where organization_id = v_org and role = 'cobrador' and is_active and lower(username) = v_user;
        if not found then raise exception 'El cobrador "%" no existe o está inactivo', v_user; end if;

        select id into v_client from public.clients where organization_id = v_org and document_number = v_doc;
        if not found then
          insert into public.clients(organization_id, document_number, full_name, phone, neighborhood, address, notes, created_by)
          values (v_org, v_doc, v_name, nullif(trim(coalesce(r->>'telefono', '')), ''), v_barrio,
                  nullif(trim(coalesce(r->>'direccion', '')), ''), 'Importado desde Excel', v_uid)
          returning id into v_client;
        else
          update public.clients set
            phone = coalesce(phone, nullif(trim(coalesce(r->>'telefono', '')), '')),
            neighborhood = coalesce(nullif(neighborhood, ''), v_barrio),
            address = coalesce(nullif(address, ''), nullif(trim(coalesce(r->>'direccion', '')), ''))
          where id = v_client;
        end if;

        v_loan := app._create_loan(v_org, v_client, v_collector, v_amount, v_rate, v_start, v_due, 0,
          'efectivo', null, 0, null, 'Importado desde Excel', v_uid, v_freq, v_cuotas, false, true);

        select total_to_pay into v_total from public.loans where id = v_loan;
        if v_paid > v_total then
          raise exception 'El valor pagado (%) es mayor que el total a pagar (%)', app.money(v_paid), app.money(v_total);
        end if;
        if v_paid > 0 then
          insert into public.payments(organization_id, loan_id, collector_id, registered_by, amount, method,
            verification_status, paid_at, notes, concept)
          values (v_org, v_loan, v_collector, v_uid, v_paid, 'efectivo', 'no_aplica',
            (v_start::timestamp + time '12:00') at time zone 'America/Bogota', 'Saldo anterior (importado)', 'saldo_anterior')
          returning id into v_pay;
          perform app._apply_payment(v_loan, v_pay, v_paid);
        end if;
        perform app.refresh_loan_status(v_loan);

        v_count := jsonb_set(v_count, array[v_collector::text], to_jsonb(coalesce((v_count->>v_collector::text)::integer, 0) + 1));
        v_out := v_out || jsonb_build_object('row', n, 'ok', true, 'loan_id', v_loan, 'total', v_total, 'balance', v_total - v_paid);
      exception when others then
        v_out := v_out || jsonb_build_object('row', n, 'ok', false, 'error', regexp_replace(sqlerrm, '^[A-Z_]+: ', ''));
      end;
    end loop;

    if p_dry_run then raise exception 'SOLO_PRUEBA'; end if;

    for k, c in select key, value::integer from jsonb_each_text(v_count) loop
      perform app.notify(v_org, k::uuid, 'prestamos_importados', 'Préstamos importados',
        'El administrador te asignó ' || c || ' préstamo' || case when c = 1 then '' else 's' end || ' importado' || case when c = 1 then '' else 's' end,
        '{}'::jsonb);
    end loop;
  exception when others then
    if sqlerrm <> 'SOLO_PRUEBA' then raise; end if;
  end;

  return jsonb_build_object('dry_run', p_dry_run, 'rows', v_out);
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
            where p.organization_id = v_org and not p.is_reversed and p.concept in ('cuota','papeleria')
              and (p.paid_at at time zone v_tz)::date >= m and (p.paid_at at time zone v_tz)::date < m + interval '1 month'), 0),
        'prestado', coalesce((select sum(l.principal) from public.loans l
            where l.organization_id = v_org and not l.imported and l.start_date >= m and l.start_date < m + interval '1 month'), 0),
        'ganancia', coalesce((select sum(a.interest_part + a.paperwork_part + a.late_fee_part)
            from public.payment_allocations a join public.payments p on p.id = a.payment_id
            where a.organization_id = v_org and not p.is_reversed and p.concept <> 'saldo_anterior'
              and (p.paid_at at time zone v_tz)::date >= m and (p.paid_at at time zone v_tz)::date < m + interval '1 month'), 0)
          + coalesce((select sum(p.amount) from public.payments p
            where p.organization_id = v_org and not p.is_reversed and p.concept = 'papeleria'
              and (p.paid_at at time zone v_tz)::date >= m and (p.paid_at at time zone v_tz)::date < m + interval '1 month'), 0)
          + coalesce((select sum(l.paperwork_fee) from public.loans l
            where l.organization_id = v_org and l.paperwork_status = 'descontada'
              and l.start_date >= m and l.start_date < m + interval '1 month'), 0)
      ) order by m)
      from generate_series(v_start, date_trunc('month', v_today)::date, interval '1 month') as g(m)
    ),
    'today_collected', coalesce((select sum(amount) from public.payments
        where organization_id = v_org and not is_reversed and concept in ('cuota','papeleria') and (paid_at at time zone v_tz)::date = v_today), 0),
    'today_due', coalesce((select sum(i.amount_due - i.amount_paid) from public.loan_installments i
        join public.loans l on l.id = i.loan_id
        where l.organization_id = v_org and l.status in ('activo','en_mora') and i.due_date <= v_today), 0),
    'pending_transfers', (select count(*) from public.payments
        where organization_id = v_org and verification_status = 'pendiente' and not is_reversed),
    'active_loans', (select count(*) from public.loans where organization_id = v_org and status in ('activo','en_mora')),
    'overdue_loans', (select count(*) from public.loans where organization_id = v_org and status = 'en_mora'),
    'projected_profit', coalesce((select sum((i.interest_due - i.interest_paid) + (i.paperwork_due - i.paperwork_paid) + (i.late_fee_due - i.late_fee_paid))
        from public.loan_installments i join public.loans l on l.id = i.loan_id
        where l.organization_id = v_org and l.status in ('activo','en_mora')), 0)
      + coalesce((select sum(paperwork_fee) from public.loans
        where organization_id = v_org and paperwork_status = 'pendiente' and status in ('activo','en_mora')), 0),
    'collectors', (
      select coalesce(jsonb_agg(jsonb_build_object(
        'id', p.id, 'full_name', p.full_name, 'username', p.username, 'is_active', p.is_active, 'last_seen_at', p.last_seen_at,
        'cash', app.wallet_balance(v_org, p.id, null),
        'collected_today', coalesce((select sum(x.amount) from public.payments x
            where x.collector_id = p.id and not x.is_reversed and x.concept in ('cuota','papeleria') and (x.paid_at at time zone v_tz)::date = v_today), 0),
        'due_today', coalesce((select sum(i.amount_due - i.amount_paid) from public.loan_installments i
            join public.loans l on l.id = i.loan_id
            where l.collector_id = p.id and l.status in ('activo','en_mora') and i.due_date <= v_today), 0),
        'active_loans', (select count(*) from public.loans l where l.collector_id = p.id and l.status in ('activo','en_mora'))
      ) order by p.full_name), '[]'::jsonb)
      from public.profiles p where p.organization_id = v_org and p.role = 'cobrador'
    )
  );
end $fn$;

create or replace function public.save_push_subscription(p_endpoint text, p_p256dh text, p_auth text, p_user_agent text default null)
returns void
language plpgsql security definer set search_path = ''
as $fn$
begin
  if auth.uid() is null then raise exception 'NO_AUTORIZADO'; end if;
  delete from public.push_subscriptions where endpoint = p_endpoint;
  insert into public.push_subscriptions(user_id, endpoint, p256dh, auth_key, user_agent)
  values (auth.uid(), p_endpoint, p_p256dh, p_auth, left(p_user_agent, 300));
end $fn$;

create or replace function public.delete_push_subscription(p_endpoint text)
returns void
language sql security definer set search_path = ''
as $fn$
  delete from public.push_subscriptions where endpoint = p_endpoint and user_id = auth.uid();
$fn$;

create or replace function public.push_config()
returns jsonb
language sql stable security definer set search_path = ''
as $fn$
  select jsonb_build_object(
    'public', (select decrypted_secret from vault.decrypted_secrets where name = 'push_vapid_public'),
    'private', (select decrypted_secret from vault.decrypted_secrets where name = 'push_vapid_private'),
    'secret', (select decrypted_secret from vault.decrypted_secrets where name = 'push_webhook_secret'),
    'subject', 'mailto:soporte@cobros.app'
  );
$fn$;

create extension if not exists pg_net;

create or replace function app.push_on_notification()
returns trigger
language plpgsql security definer set search_path = ''
as $fn$
begin
  if exists (select 1 from public.push_subscriptions where user_id = new.recipient_id) then
    begin
      perform net.http_post(
        url := 'https://zoymgncezhbkbypqbhyu.supabase.co/functions/v1/send-push',
        body := jsonb_build_object('notification_id', new.id),
        headers := jsonb_build_object('Content-Type', 'application/json',
          'x-push-secret', coalesce((select decrypted_secret from vault.decrypted_secrets where name = 'push_webhook_secret'), ''))
      );
    exception when others then null;
    end;
  end if;
  return new;
end $fn$;

drop trigger if exists trg_push_notification on public.notifications;
create trigger trg_push_notification after insert on public.notifications
for each row execute function app.push_on_notification();

revoke all on function public.push_config() from public, anon, authenticated;
grant execute on function public.push_config() to service_role;
revoke all on function public.import_loans(jsonb, boolean) from public, anon;
grant execute on function public.import_loans(jsonb, boolean) to authenticated;
revoke all on function public.charge_paperwork(uuid, public.payment_method, uuid, text, timestamptz, uuid) from public, anon;
grant execute on function public.charge_paperwork(uuid, public.payment_method, uuid, text, timestamptz, uuid) to authenticated;
revoke all on function public.create_loan(uuid, numeric, numeric, date, date, uuid, numeric, public.payment_method, uuid, text, text, integer, boolean) from public, anon;
grant execute on function public.create_loan(uuid, numeric, numeric, date, date, uuid, numeric, public.payment_method, uuid, text, text, integer, boolean) to authenticated;
revoke all on function public.renew_loan(uuid, numeric, numeric, date, numeric, public.payment_method, uuid, text, text, integer, boolean) from public, anon;
grant execute on function public.renew_loan(uuid, numeric, numeric, date, numeric, public.payment_method, uuid, text, text, integer, boolean) to authenticated;
revoke all on function public.save_push_subscription(text, text, text, text) from public, anon;
grant execute on function public.save_push_subscription(text, text, text, text) to authenticated;
revoke all on function public.delete_push_subscription(text) from public, anon;
grant execute on function public.delete_push_subscription(text) to authenticated;
revoke all on function app.loan_dates(uuid, text, date, date, integer) from public, anon, authenticated;
revoke all on function app._create_loan(uuid, uuid, uuid, numeric, numeric, date, date, numeric, public.payment_method, uuid, numeric, uuid, text, uuid, text, integer, boolean, boolean) from public, anon, authenticated;
