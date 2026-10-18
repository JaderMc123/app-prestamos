-- Observación del cobrador (no pagó, promesa de pago...). Idempotente para registros hechos sin señal.
create or replace function public.add_collection_log(p_loan_id uuid, p_type public.log_type, p_note text default null,
  p_promised_date date default null, p_client_uuid uuid default null)
returns uuid language plpgsql security definer set search_path = '' as $$
declare
  v_org uuid := app.current_org_id();
  v_uid uuid := auth.uid();
  v_loan public.loans%rowtype;
  v_id uuid;
begin
  if v_org is null then raise exception 'NO_AUTORIZADO'; end if;
  if p_client_uuid is not null then
    select id into v_id from public.collection_logs where client_uuid = p_client_uuid;
    if found then return v_id; end if;
  end if;
  select * into v_loan from public.loans where id = p_loan_id and organization_id = v_org;
  if not found then raise exception 'PRESTAMO_NO_ENCONTRADO'; end if;
  if not app.is_admin() and v_loan.collector_id <> v_uid then raise exception 'NO_AUTORIZADO'; end if;

  insert into public.collection_logs(organization_id, loan_id, collector_id, type, note, promised_date, log_date, client_uuid)
  values (v_org, p_loan_id, v_uid, p_type, nullif(trim(p_note), ''), p_promised_date, app.org_today(v_org), p_client_uuid)
  returning id into v_id;
  return v_id;
end $$;

revoke all on function public.add_collection_log(uuid, public.log_type, text, date, uuid) from public, anon;
grant execute on function public.add_collection_log(uuid, public.log_type, text, date, uuid) to authenticated;
