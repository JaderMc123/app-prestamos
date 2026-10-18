-- Resumen para el inicio del administrador (cálculo en la base de datos, no en el celular)
create or replace function public.admin_overview() returns jsonb
language plpgsql stable security definer set search_path = '' as $$
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
            where p.organization_id = v_org and not p.is_reversed and p.method <> 'renovacion'
              and (p.paid_at at time zone v_tz)::date >= m and (p.paid_at at time zone v_tz)::date < m + interval '1 month'), 0),
        'prestado', coalesce((select sum(l.principal) from public.loans l
            where l.organization_id = v_org and l.start_date >= m and l.start_date < m + interval '1 month'), 0),
        'ganancia', coalesce((select sum(a.interest_part + a.paperwork_part + a.late_fee_part)
            from public.payment_allocations a join public.payments p on p.id = a.payment_id
            where a.organization_id = v_org and not p.is_reversed
              and (p.paid_at at time zone v_tz)::date >= m and (p.paid_at at time zone v_tz)::date < m + interval '1 month'), 0)
      ) order by m)
      from generate_series(v_start, date_trunc('month', v_today)::date, interval '1 month') as g(m)
    ),
    'today_collected', coalesce((select sum(amount) from public.payments
        where organization_id = v_org and not is_reversed and method <> 'renovacion' and (paid_at at time zone v_tz)::date = v_today), 0),
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
            where x.collector_id = p.id and not x.is_reversed and x.method <> 'renovacion' and (x.paid_at at time zone v_tz)::date = v_today), 0),
        'due_today', coalesce((select sum(i.amount_due - i.amount_paid) from public.loan_installments i
            join public.loans l on l.id = i.loan_id
            where l.collector_id = p.id and l.status in ('activo','en_mora') and i.due_date <= v_today), 0),
        'active_loans', (select count(*) from public.loans l where l.collector_id = p.id and l.status in ('activo','en_mora'))
      ) order by p.full_name), '[]'::jsonb)
      from public.profiles p where p.organization_id = v_org and p.role = 'cobrador'
    )
  );
end $$;

revoke all on function public.admin_overview() from public, anon;
grant execute on function public.admin_overview() to authenticated;
revoke all on function app.wallet_balance(uuid, uuid, uuid) from public;
