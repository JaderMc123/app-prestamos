create or replace function app.money(p numeric) returns text
language sql immutable set search_path = '' as $$
  select '$' || replace(to_char(round(p), 'FM999G999G999G990'), ',', '.')
$$;

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
    app.org_today(v_org), p_due_date, coalesce(p_paperwork_fee, v_old.paperwork_daily_fee), p_disbursement_method,
    p_disbursement_account_id, p_principal - v_rem, p_old_loan_id, p_notes, v_uid);

  if v_rem > 0 then
    insert into public.payments(organization_id, loan_id, collector_id, registered_by, amount, method, verification_status, notes)
    values (v_org, p_old_loan_id, v_old.collector_id, v_uid, v_rem, 'renovacion', 'no_aplica', 'Saldo cubierto por renovación')
    returning id into v_pay;
    perform app._apply_payment(p_old_loan_id, v_pay, v_rem);
  end if;

  update public.loans set status = 'renovado', closed_at = now() where id = p_old_loan_id;
  return v_new;
end $$;

revoke all on function public.renew_loan(uuid, numeric, numeric, date, numeric, public.payment_method, uuid, text) from public, anon;
grant execute on function public.renew_loan(uuid, numeric, numeric, date, numeric, public.payment_method, uuid, text) to authenticated;
revoke all on function app.money(numeric) from public;
