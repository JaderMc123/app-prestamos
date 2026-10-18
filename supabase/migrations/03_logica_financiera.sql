-- ===== Internas =====
create or replace function app.wallet_balance(p_org uuid, p_collector uuid, p_account uuid)
returns numeric language sql stable security definer set search_path = '' as $$
  select coalesce(sum(amount), 0) from public.capital_movements
  where organization_id = p_org
    and wallet_collector_id is not distinct from p_collector
    and wallet_account_id is not distinct from p_account
$$;

create or replace function app.collection_dates(p_collector uuid, p_after date, p_until date)
returns setof date language sql stable security definer set search_path = '' as $$
  select g.d::date
  from generate_series((p_after + 1)::timestamp, p_until::timestamp, interval '1 day') as g(d)
  where extract(isodow from g.d)::smallint = any (
    coalesce((select s.weekdays from public.collection_schedules s where s.collector_id = p_collector),
             '{1,2,3,4,5,6}'::smallint[]))
  order by 1
$$;

create or replace function app.refresh_loan_status(p_loan uuid) returns void
language plpgsql security definer set search_path = '' as $$
declare
  v_l public.loans%rowtype;
  v_bal numeric;
begin
  select * into v_l from public.loans where id = p_loan;
  if v_l.status in ('renovado','castigado') then return; end if;
  select coalesce(sum(amount_due - amount_paid), 0) into v_bal from public.loan_installments where loan_id = p_loan;
  if v_bal <= 0 then
    update public.loans set status = 'pagado', closed_at = coalesce(closed_at, now()) where id = p_loan;
  elsif app.org_today(v_l.organization_id) > v_l.due_date then
    update public.loans set status = 'en_mora', closed_at = null where id = p_loan;
  else
    update public.loans set status = 'activo', closed_at = null where id = p_loan;
  end if;
end $$;

create or replace function app._create_loan(
  p_org uuid, p_client uuid, p_collector uuid, p_principal numeric, p_interest_rate numeric,
  p_start date, p_due date, p_paperwork_fee numeric, p_disb_method public.payment_method,
  p_disb_account uuid, p_disb_amount numeric, p_renewed_from uuid, p_notes text, p_created_by uuid
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_set public.settings%rowtype;
  v_fee numeric(14,2);
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

  select * into v_set from public.settings where organization_id = p_org;
  v_fee := coalesce(v_set.paperwork_daily_fee, p_paperwork_fee);
  if v_fee is null then
    raise exception 'PAPELERIA_REQUERIDA: el administrador no ha configurado la papelería; ingrese el valor';
  end if;
  if v_fee < 0 then raise exception 'PAPELERIA_INVALIDA'; end if;

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

  -- Origen del desembolso y verificación de capital
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
      v_amt := v_base - v_per * (v_n - 1);   -- el residuo va a la última cuota
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

-- Reparte un pago entre las cuotas más antiguas: recargo -> papelería -> interés -> capital
create or replace function app._apply_payment(p_loan uuid, p_payment uuid, p_amount numeric) returns void
language plpgsql security definer set search_path = '' as $$
declare
  r record;
  v_left numeric(14,2) := p_amount;
  v_rem numeric;
  v_lf numeric(14,2); v_pp numeric(14,2); v_int numeric(14,2); v_pr numeric(14,2);
  v_org uuid;
begin
  select organization_id into v_org from public.loans where id = p_loan;
  select coalesce(sum(amount_due - amount_paid), 0) into v_rem from public.loan_installments where loan_id = p_loan;
  if p_amount > v_rem then
    raise exception 'PAGO_EXCEDE_SALDO: el saldo pendiente es %', app.money(v_rem);
  end if;

  for r in
    select * from public.loan_installments
    where loan_id = p_loan and amount_paid < amount_due
    order by due_date, number
    for update
  loop
    exit when v_left <= 0;
    v_lf  := least(v_left, r.late_fee_due  - r.late_fee_paid);  v_left := v_left - v_lf;
    v_pp  := least(v_left, r.paperwork_due - r.paperwork_paid); v_left := v_left - v_pp;
    v_int := least(v_left, r.interest_due  - r.interest_paid);  v_left := v_left - v_int;
    v_pr  := least(v_left, r.principal_due - r.principal_paid); v_left := v_left - v_pr;

    update public.loan_installments set
      late_fee_paid  = late_fee_paid + v_lf,
      paperwork_paid = paperwork_paid + v_pp,
      interest_paid  = interest_paid + v_int,
      principal_paid = principal_paid + v_pr,
      status = case when r.amount_paid + v_lf + v_pp + v_int + v_pr >= r.amount_due
                    then 'pagada'::public.installment_status
                    else 'parcial'::public.installment_status end
    where id = r.id;

    insert into public.payment_allocations(organization_id, payment_id, installment_id,
      principal_part, interest_part, paperwork_part, late_fee_part)
    values (v_org, p_payment, r.id, v_pr, v_int, v_pp, v_lf);
  end loop;

  perform app.refresh_loan_status(p_loan);
end $$;

create or replace function app._reverse_payment(p_payment uuid, p_reason text) returns void
language plpgsql security definer set search_path = '' as $$
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

  select * into v_m from public.capital_movements where payment_id = p_payment and type = 'cobro' limit 1;
  if found then
    insert into public.capital_movements(organization_id, type, amount, wallet_collector_id, wallet_account_id, loan_id, payment_id, note, created_by)
    values (v_m.organization_id, 'reverso_cobro', -v_m.amount, v_m.wallet_collector_id, v_m.wallet_account_id,
            v_p.loan_id, p_payment, p_reason, auth.uid());
  end if;

  perform app.refresh_loan_status(v_p.loan_id);
end $$;

-- ===== RPC públicas =====

create or replace function public.find_client_by_document(p_document text)
returns table(id uuid, document_number text, full_name text, phone text, address text,
              latitude numeric, longitude numeric, data_consent_accepted boolean, active_loans integer)
language sql stable security definer set search_path = '' as $$
  select c.id, c.document_number, c.full_name, c.phone, c.address, c.latitude, c.longitude,
         c.data_consent_accepted,
         (select count(*)::int from public.loans l where l.client_id = c.id and l.status in ('activo','en_mora'))
  from public.clients c
  where c.organization_id = app.current_org_id()
    and c.document_number = upper(regexp_replace(coalesce(p_document,''), '[^0-9A-Za-z]', '', 'g'))
$$;

create or replace function public.create_loan(
  p_client_id uuid, p_principal numeric, p_interest_rate numeric, p_due_date date,
  p_start_date date default null, p_collector_id uuid default null, p_paperwork_fee numeric default null,
  p_disbursement_method public.payment_method default 'efectivo',
  p_disbursement_account_id uuid default null, p_notes text default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
  v_uid uuid := auth.uid();
  v_collector uuid;
  v_client public.clients%rowtype;
begin
  if v_org is null then raise exception 'NO_AUTORIZADO'; end if;
  v_collector := case when app.is_admin() then coalesce(p_collector_id, v_uid) else v_uid end;

  perform 1 from public.profiles where id = v_collector and organization_id = v_org and is_active;
  if not found then raise exception 'COBRADOR_INVALIDO'; end if;

  select * into v_client from public.clients where id = p_client_id and organization_id = v_org;
  if not found then raise exception 'CLIENTE_NO_ENCONTRADO'; end if;
  if not v_client.data_consent_accepted then
    raise exception 'SIN_AUTORIZACION_DATOS: el cliente debe aceptar el tratamiento de datos personales';
  end if;
  if p_disbursement_method = 'renovacion' then raise exception 'METODO_INVALIDO'; end if;

  return app._create_loan(v_org, p_client_id, v_collector, p_principal, p_interest_rate,
    coalesce(p_start_date, app.org_today(v_org)), p_due_date, p_paperwork_fee,
    p_disbursement_method, p_disbursement_account_id, p_principal, null, p_notes, v_uid);
end $$;

create or replace function public.register_payment(
  p_loan_id uuid, p_amount numeric, p_method public.payment_method default 'efectivo',
  p_account_id uuid default null, p_transfer_reference text default null, p_receipt_path text default null,
  p_paid_at timestamptz default null, p_latitude numeric default null, p_longitude numeric default null,
  p_notes text default null, p_client_uuid uuid default null
) returns uuid language plpgsql security definer set search_path = '' as $$
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

  -- Idempotencia para pagos registrados sin conexión
  if p_client_uuid is not null then
    select id into v_id from public.payments where client_uuid = p_client_uuid and organization_id = v_org;
    if found then return v_id; end if;
  end if;

  if p_amount is null or p_amount <= 0 then raise exception 'MONTO_INVALIDO'; end if;

  select * into v_loan from public.loans where id = p_loan_id and organization_id = v_org for update;
  if not found then raise exception 'PRESTAMO_NO_ENCONTRADO'; end if;
  if not app.is_admin() and v_loan.collector_id <> v_uid then raise exception 'NO_AUTORIZADO'; end if;
  if v_loan.status not in ('activo','en_mora') then raise exception 'PRESTAMO_CERRADO: el préstamo no está activo'; end if;

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
    payment_account_id, transfer_reference, receipt_path, verification_status, paid_at,
    latitude, longitude, notes, client_uuid)
  values (v_org, p_loan_id, v_loan.collector_id, v_uid, p_amount, p_method,
    case when p_method = 'transferencia' then v_acc.id end, v_ref, p_receipt_path, v_status,
    coalesce(p_paid_at, now()), p_latitude, p_longitude, p_notes, p_client_uuid)
  returning id into v_id;

  perform app._apply_payment(p_loan_id, v_id, p_amount);

  insert into public.capital_movements(organization_id, type, amount, wallet_collector_id, wallet_account_id, loan_id, payment_id, note, created_by)
  values (v_org, 'cobro', p_amount, v_wc, v_wa, p_loan_id, v_id, 'Cobro', v_uid);

  if p_method = 'transferencia' then
    select full_name into v_client from public.clients where id = v_loan.client_id;
    perform app.notify_admins(v_org, 'transferencia_pendiente', 'Transferencia por verificar',
      v_client || ': ' || app.money(p_amount) || ' a ' || v_acc.name,
      jsonb_build_object('payment_id', v_id, 'loan_id', p_loan_id, 'collector_id', v_loan.collector_id));
  end if;

  return v_id;
end $$;

create or replace function public.verify_transfer(p_payment_id uuid, p_approved boolean, p_reason text default null)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
  v_p public.payments%rowtype;
  v_client text;
begin
  if not app.is_admin() then raise exception 'NO_AUTORIZADO'; end if;
  select * into v_p from public.payments where id = p_payment_id and organization_id = v_org for update;
  if not found then raise exception 'PAGO_NO_ENCONTRADO'; end if;
  if v_p.method <> 'transferencia' or v_p.verification_status <> 'pendiente' or v_p.is_reversed then
    raise exception 'NO_PENDIENTE: el pago no está pendiente de verificación';
  end if;

  if p_approved then
    update public.payments set verification_status = 'verificado', verified_by = auth.uid(), verified_at = now()
    where id = p_payment_id;
  else
    perform app._reverse_payment(p_payment_id, coalesce(p_reason, 'Transferencia rechazada'));
    update public.payments set verification_status = 'rechazado', verified_by = auth.uid(),
      verified_at = now(), rejection_reason = p_reason
    where id = p_payment_id;
    select c.full_name into v_client from public.loans l join public.clients c on c.id = l.client_id where l.id = v_p.loan_id;
    perform app.notify(v_org, v_p.collector_id, 'transferencia_rechazada', 'Transferencia rechazada',
      v_client || ': ' || app.money(v_p.amount) || ' no llegó. La cuota volvió a quedar pendiente.',
      jsonb_build_object('payment_id', p_payment_id, 'loan_id', v_p.loan_id, 'reason', p_reason));
  end if;
end $$;

create or replace function public.reverse_payment(p_payment_id uuid, p_reason text)
returns void language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
begin
  if not app.is_admin() then raise exception 'NO_AUTORIZADO'; end if;
  perform 1 from public.payments where id = p_payment_id and organization_id = v_org;
  if not found then raise exception 'PAGO_NO_ENCONTRADO'; end if;
  if coalesce(trim(p_reason), '') = '' then raise exception 'MOTIVO_REQUERIDO'; end if;
  perform app._reverse_payment(p_payment_id, p_reason);
end $$;

create or replace function public.renew_loan(
  p_old_loan_id uuid, p_principal numeric, p_interest_rate numeric, p_due_date date,
  p_paperwork_fee numeric default null, p_disbursement_method public.payment_method default 'efectivo',
  p_disbursement_account_id uuid default null, p_notes text default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
  v_uid uuid := auth.uid();
  v_old public.loans%rowtype;
  v_rem numeric;
  v_new uuid;
  v_pay uuid;
begin
  if v_org is null then raise exception 'NO_AUTORIZADO'; end if;
  select * into v_old from public.loans where id = p_old_loan_id and organization_id = v_org for update;
  if not found then raise exception 'PRESTAMO_NO_ENCONTRADO'; end if;
  if not app.is_admin() and v_old.collector_id <> v_uid then raise exception 'NO_AUTORIZADO'; end if;
  if v_old.status not in ('activo','en_mora') then raise exception 'PRESTAMO_CERRADO'; end if;
  if p_disbursement_method = 'renovacion' then raise exception 'METODO_INVALIDO'; end if;
  perform 1 from public.clients where id = v_old.client_id and data_consent_accepted;
  if not found then raise exception 'SIN_AUTORIZACION_DATOS'; end if;

  select coalesce(sum(amount_due - amount_paid), 0) into v_rem from public.loan_installments where loan_id = p_old_loan_id;
  if p_principal < v_rem then
    raise exception 'MONTO_INSUFICIENTE: el nuevo préstamo debe cubrir el saldo pendiente de %', app.money(v_rem);
  end if;

  v_new := app._create_loan(v_org, v_old.client_id, v_old.collector_id, p_principal, p_interest_rate,
    app.org_today(v_org), p_due_date, p_paperwork_fee, p_disbursement_method,
    p_disbursement_account_id, p_principal - v_rem, p_old_loan_id, p_notes, v_uid);

  if v_rem > 0 then
    insert into public.payments(organization_id, loan_id, collector_id, registered_by, amount, method, verification_status, notes)
    values (v_org, p_old_loan_id, v_old.collector_id, v_uid, v_rem, 'renovacion', 'no_aplica',
            'Saldo cubierto por renovación')
    returning id into v_pay;
    perform app._apply_payment(p_old_loan_id, v_pay, v_rem);
  end if;

  update public.loans set status = 'renovado', closed_at = now() where id = p_old_loan_id;
  return v_new;
end $$;

create or replace function public.reassign_loans(p_loan_ids uuid[], p_to_collector uuid, p_reason text default null)
returns integer language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
  v_uid uuid := auth.uid();
  v_count integer := 0;
  r record;
begin
  if not app.is_admin() then raise exception 'NO_AUTORIZADO'; end if;
  perform 1 from public.profiles where id = p_to_collector and organization_id = v_org and is_active;
  if not found then raise exception 'COBRADOR_INVALIDO'; end if;

  for r in
    select l.id, l.collector_id, l.client_id, c.full_name
    from public.loans l join public.clients c on c.id = l.client_id
    where l.id = any(p_loan_ids) and l.organization_id = v_org
      and l.status in ('activo','en_mora') and l.collector_id <> p_to_collector
    for update of l
  loop
    insert into public.client_assignment_history(organization_id, loan_id, client_id, from_collector_id, to_collector_id, reassigned_by, reason)
    values (v_org, r.id, r.client_id, r.collector_id, p_to_collector, v_uid, p_reason);
    update public.loans set collector_id = p_to_collector where id = r.id;
    perform app.notify(v_org, r.collector_id, 'cliente_reasignado_salida', 'Cliente reasignado',
      r.full_name || ' ya no hace parte de tu ruta', jsonb_build_object('loan_id', r.id, 'client_id', r.client_id));
    perform app.notify(v_org, p_to_collector, 'cliente_reasignado_entrada', 'Nuevo cliente en tu ruta',
      r.full_name || ' fue asignado a tu ruta', jsonb_build_object('loan_id', r.id, 'client_id', r.client_id));
    v_count := v_count + 1;
  end loop;
  return v_count;
end $$;

create or replace function public.add_capital(p_amount numeric, p_is_withdrawal boolean default false,
  p_account_id uuid default null, p_note text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
  v_id uuid;
  v_bal numeric;
begin
  if not app.is_admin() then raise exception 'NO_AUTORIZADO'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'MONTO_INVALIDO'; end if;
  if p_account_id is not null then
    perform 1 from public.payment_accounts where id = p_account_id and organization_id = v_org and collector_id is null;
    if not found then raise exception 'CUENTA_INVALIDA: debe ser una cuenta de la organización'; end if;
  end if;
  if p_is_withdrawal then
    v_bal := app.wallet_balance(v_org, null, p_account_id);
    if v_bal < p_amount then raise exception 'CAPITAL_INSUFICIENTE: saldo disponible %', app.money(v_bal); end if;
  end if;
  insert into public.capital_movements(organization_id, type, amount, wallet_collector_id, wallet_account_id, note, created_by)
  values (v_org, case when p_is_withdrawal then 'retiro'::public.movement_type else 'aporte_base'::public.movement_type end,
          case when p_is_withdrawal then -p_amount else p_amount end, null, p_account_id, p_note, auth.uid())
  returning id into v_id;
  return v_id;
end $$;

-- Mueve dinero entre bolsillos: tesorería (collector null) <-> cobradores, efectivo (account null) o cuentas
create or replace function public.transfer_capital(p_amount numeric,
  p_from_collector uuid default null, p_to_collector uuid default null,
  p_from_account uuid default null, p_to_account uuid default null, p_note text default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
  v_group uuid := gen_random_uuid();
  v_type public.movement_type;
  v_bal numeric;
begin
  if not app.is_admin() then raise exception 'NO_AUTORIZADO'; end if;
  if p_amount is null or p_amount <= 0 then raise exception 'MONTO_INVALIDO'; end if;
  if p_from_collector is not distinct from p_to_collector and p_from_account is not distinct from p_to_account then
    raise exception 'ORIGEN_Y_DESTINO_IGUALES';
  end if;
  if p_from_collector is not null then
    perform 1 from public.profiles where id = p_from_collector and organization_id = v_org;
    if not found then raise exception 'COBRADOR_INVALIDO'; end if;
  end if;
  if p_to_collector is not null then
    perform 1 from public.profiles where id = p_to_collector and organization_id = v_org and is_active;
    if not found then raise exception 'COBRADOR_INVALIDO'; end if;
  end if;
  if p_from_account is not null and not exists (select 1 from public.payment_accounts
      where id = p_from_account and organization_id = v_org and collector_id is not distinct from p_from_collector) then
    raise exception 'CUENTA_INVALIDA: la cuenta de origen no pertenece a ese bolsillo';
  end if;
  if p_to_account is not null and not exists (select 1 from public.payment_accounts
      where id = p_to_account and organization_id = v_org and collector_id is not distinct from p_to_collector) then
    raise exception 'CUENTA_INVALIDA: la cuenta de destino no pertenece a ese bolsillo';
  end if;

  v_bal := app.wallet_balance(v_org, p_from_collector, p_from_account);
  if v_bal < p_amount then raise exception 'CAPITAL_INSUFICIENTE: saldo disponible %', app.money(v_bal); end if;

  v_type := case
    when p_from_collector is null and p_to_collector is not null then 'asignacion'
    when p_from_collector is not null and p_to_collector is null then 'devolucion'
    else 'ajuste' end;

  insert into public.capital_movements(organization_id, type, amount, wallet_collector_id, wallet_account_id, transfer_group, note, created_by)
  values (v_org, v_type, -p_amount, p_from_collector, p_from_account, v_group, p_note, auth.uid()),
         (v_org, v_type,  p_amount, p_to_collector,   p_to_account,   v_group, p_note, auth.uid());

  if p_to_collector is not null then
    perform app.notify(v_org, p_to_collector, 'capital_asignado', 'Capital recibido',
      'Te asignaron ' || app.money(p_amount), jsonb_build_object('transfer_group', v_group));
  end if;
  return v_group;
end $$;

create or replace function public.get_capital_summary()
returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
  v_uid uuid := auth.uid();
  v_full boolean;
begin
  if v_org is null then raise exception 'NO_AUTORIZADO'; end if;
  select (role = 'admin' or can_view_total_capital) into v_full from public.profiles where id = v_uid;
  return jsonb_build_object(
    'mi_efectivo', app.wallet_balance(v_org, v_uid, null),
    'mis_cuentas', (select coalesce(sum(amount),0) from public.capital_movements
                    where organization_id = v_org and wallet_collector_id = v_uid and wallet_account_id is not null),
    'mi_capital_en_calle', (select coalesce(sum(i.principal_due - i.principal_paid),0)
                    from public.loan_installments i join public.loans l on l.id = i.loan_id
                    where l.organization_id = v_org and l.collector_id = v_uid and l.status in ('activo','en_mora')),
    'capital_liquido_total', case when v_full then (select coalesce(sum(amount),0) from public.capital_movements where organization_id = v_org) end,
    'tesoreria', case when v_full then (select coalesce(sum(amount),0) from public.capital_movements
                    where organization_id = v_org and wallet_collector_id is null) end,
    'capital_en_calle_total', case when v_full then (select coalesce(sum(i.principal_due - i.principal_paid),0)
                    from public.loan_installments i join public.loans l on l.id = i.loan_id
                    where l.organization_id = v_org and l.status in ('activo','en_mora')) end
  );
end $$;

create or replace function public.close_cash(
  p_collector_id uuid, p_cash_reported numeric, p_cash_handed_over numeric default 0,
  p_apply_adjustment boolean default false, p_date date default null, p_notes text default null
) returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
  v_uid uuid := auth.uid();
  v_tz text;
  v_date date;
  v_pending integer;
  v_cash numeric; v_tc numeric; v_to numeric; v_disb numeric; v_exp numeric; v_expected numeric;
  v_id uuid;
  v_group uuid;
begin
  if not app.is_admin() then raise exception 'NO_AUTORIZADO'; end if;
  perform 1 from public.profiles where id = p_collector_id and organization_id = v_org;
  if not found then raise exception 'COBRADOR_INVALIDO'; end if;
  if p_cash_reported is null or p_cash_reported < 0 then raise exception 'MONTO_INVALIDO'; end if;

  select timezone into v_tz from public.organizations where id = v_org;
  v_date := coalesce(p_date, app.org_today(v_org));

  select count(*) into v_pending from public.payments
  where organization_id = v_org and collector_id = p_collector_id
    and verification_status = 'pendiente' and not is_reversed
    and (paid_at at time zone v_tz)::date <= v_date;
  if v_pending > 0 then
    raise exception 'TRANSFERENCIAS_PENDIENTES: hay % transferencia(s) sin verificar', v_pending;
  end if;

  select coalesce(sum(p.amount) filter (where p.method = 'efectivo'), 0),
         coalesce(sum(p.amount) filter (where p.method = 'transferencia' and a.collector_id is not null), 0),
         coalesce(sum(p.amount) filter (where p.method = 'transferencia' and a.collector_id is null), 0)
    into v_cash, v_tc, v_to
  from public.payments p left join public.payment_accounts a on a.id = p.payment_account_id
  where p.organization_id = v_org and p.collector_id = p_collector_id and not p.is_reversed
    and (p.paid_at at time zone v_tz)::date = v_date;

  select coalesce(-sum(amount), 0) into v_disb from public.capital_movements
  where organization_id = v_org and wallet_collector_id = p_collector_id and wallet_account_id is null
    and type = 'desembolso' and (created_at at time zone v_tz)::date = v_date;

  select coalesce(sum(amount), 0) into v_exp from public.expenses
  where organization_id = v_org and collector_id = p_collector_id and kind = 'eventual_cobrador' and expense_date = v_date;

  v_expected := app.wallet_balance(v_org, p_collector_id, null);

  insert into public.cash_closures(organization_id, collector_id, closure_date, cash_collected,
    transfers_collector_accounts, transfers_org_accounts, cash_disbursed, expenses_total,
    cash_expected, cash_reported, cash_handed_over, adjustment_applied, notes, closed_by)
  values (v_org, p_collector_id, v_date, v_cash, v_tc, v_to, v_disb, v_exp,
    v_expected, p_cash_reported, coalesce(p_cash_handed_over, 0),
    p_apply_adjustment and p_cash_reported <> v_expected, p_notes, v_uid)
  returning id into v_id;

  -- Ajuste por diferencia (faltante/sobrante) si el admin lo aprueba
  if p_apply_adjustment and p_cash_reported <> v_expected then
    insert into public.capital_movements(organization_id, type, amount, wallet_collector_id, cash_closure_id, note, created_by)
    values (v_org, 'ajuste', p_cash_reported - v_expected, p_collector_id, v_id, 'Ajuste de cuadre', v_uid);
  end if;

  -- Entrega de efectivo al admin
  if coalesce(p_cash_handed_over, 0) > 0 then
    if p_cash_handed_over > p_cash_reported then
      raise exception 'MONTO_INVALIDO: no puede entregar más de lo que reporta';
    end if;
    v_group := gen_random_uuid();
    insert into public.capital_movements(organization_id, type, amount, wallet_collector_id, transfer_group, cash_closure_id, note, created_by)
    values (v_org, 'devolucion', -p_cash_handed_over, p_collector_id, v_group, v_id, 'Entrega en cuadre', v_uid),
           (v_org, 'devolucion',  p_cash_handed_over, null,           v_group, v_id, 'Entrega en cuadre', v_uid);
  end if;

  perform app.notify(v_org, p_collector_id, 'cuadre_cerrado', 'Cuadre cerrado',
    'Cuadre del ' || to_char(v_date, 'DD/MM/YYYY') || '. Diferencia: ' || app.money(p_cash_reported - v_expected),
    jsonb_build_object('cash_closure_id', v_id));
  return v_id;
end $$;

-- Permisos de ejecución
revoke all on function public.find_client_by_document(text) from public, anon;
revoke all on function public.create_loan(uuid, numeric, numeric, date, date, uuid, numeric, public.payment_method, uuid, text) from public, anon;
revoke all on function public.register_payment(uuid, numeric, public.payment_method, uuid, text, text, timestamptz, numeric, numeric, text, uuid) from public, anon;
revoke all on function public.verify_transfer(uuid, boolean, text) from public, anon;
revoke all on function public.reverse_payment(uuid, text) from public, anon;
revoke all on function public.renew_loan(uuid, numeric, numeric, date, numeric, public.payment_method, uuid, text) from public, anon;
revoke all on function public.reassign_loans(uuid[], uuid, text) from public, anon;
revoke all on function public.add_capital(numeric, boolean, uuid, text) from public, anon;
revoke all on function public.transfer_capital(numeric, uuid, uuid, uuid, uuid, text) from public, anon;
revoke all on function public.get_capital_summary() from public, anon;
revoke all on function public.close_cash(uuid, numeric, numeric, boolean, date, text) from public, anon;

grant execute on function public.find_client_by_document(text),
  public.create_loan(uuid, numeric, numeric, date, date, uuid, numeric, public.payment_method, uuid, text),
  public.register_payment(uuid, numeric, public.payment_method, uuid, text, text, timestamptz, numeric, numeric, text, uuid),
  public.verify_transfer(uuid, boolean, text),
  public.reverse_payment(uuid, text),
  public.renew_loan(uuid, numeric, numeric, date, numeric, public.payment_method, uuid, text),
  public.reassign_loans(uuid[], uuid, text),
  public.add_capital(numeric, boolean, uuid, text),
  public.transfer_capital(numeric, uuid, uuid, uuid, uuid, text),
  public.get_capital_summary(),
  public.close_cash(uuid, numeric, numeric, boolean, date, text)
to authenticated;

revoke all on all functions in schema app from public;
grant execute on function app.current_org_id(), app.is_admin(), app.org_today(uuid),
  app.safe_uuid(text), app.can_see_client(uuid) to authenticated;
