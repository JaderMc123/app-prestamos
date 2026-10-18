create schema if not exists app;
grant usage on schema app to authenticated;

-- ===== Tipos =====
create type public.user_role as enum ('admin','cobrador');
create type public.loan_status as enum ('activo','en_mora','pagado','renovado','castigado');
create type public.installment_kind as enum ('regular','papeleria_mora','recargo_mora');
create type public.installment_status as enum ('pendiente','parcial','pagada');
create type public.payment_method as enum ('efectivo','transferencia','renovacion');
create type public.verification_status as enum ('no_aplica','pendiente','verificado','rechazado');
create type public.account_type as enum ('nequi','bancolombia','daviplata','otro_banco','otro');
create type public.movement_type as enum ('aporte_base','retiro','asignacion','devolucion','desembolso','cobro','reverso_cobro','gasto','ajuste');
create type public.expense_kind as enum ('fijo_admin','eventual_cobrador');
create type public.cost_frequency as enum ('diario','semanal','quincenal','mensual');
create type public.log_type as enum ('no_pago','pago_parcial','promesa_pago','cliente_ausente','otro');
create type public.late_fee_type as enum ('fijo','porcentaje');
create type public.late_fee_base as enum ('saldo','total');

create or replace function app.set_updated_at() returns trigger
language plpgsql set search_path = '' as $$
begin new.updated_at := now(); return new; end $$;

-- ===== Organización y usuarios =====
create table public.organizations (
  id uuid primary key default gen_random_uuid(),
  name text not null check (length(trim(name)) > 0),
  currency text not null default 'COP',
  timezone text not null default 'America/Bogota',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table public.profiles (
  id uuid primary key references auth.users(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  full_name text not null,
  username text,
  phone text,
  role public.user_role not null,
  is_active boolean not null default true,
  can_view_total_capital boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, username)
);
create index profiles_org_idx on public.profiles(organization_id);

create table public.settings (
  organization_id uuid primary key references public.organizations(id) on delete cascade,
  paperwork_daily_fee numeric(14,2) check (paperwork_daily_fee >= 0),
  installment_rounding integer not null default 100 check (installment_rounding >= 0),
  late_fee_enabled boolean not null default false,
  late_fee_type public.late_fee_type,
  late_fee_value numeric(14,2) check (late_fee_value >= 0),
  late_fee_base public.late_fee_base not null default 'saldo',
  late_fee_grace_days integer not null default 0 check (late_fee_grace_days >= 0),
  late_fee_recurring boolean not null default false,
  late_fee_every_days integer check (late_fee_every_days > 0),
  updated_at timestamptz not null default now(),
  check (not late_fee_enabled or (late_fee_type is not null and late_fee_value is not null)),
  check (not late_fee_recurring or late_fee_every_days is not null)
);

create table public.collection_schedules (
  collector_id uuid primary key references public.profiles(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  weekdays smallint[] not null default '{1,2,3,4,5,6}',
  updated_at timestamptz not null default now(),
  check (cardinality(weekdays) > 0 and weekdays <@ '{1,2,3,4,5,6,7}'::smallint[])
);
create index collection_schedules_org_idx on public.collection_schedules(organization_id);

create table public.payment_accounts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  collector_id uuid references public.profiles(id) on delete set null,
  name text not null,
  type public.account_type not null,
  account_number text,
  owner_name text,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
create index payment_accounts_org_idx on public.payment_accounts(organization_id);
create index payment_accounts_collector_idx on public.payment_accounts(collector_id);

-- ===== Clientes =====
create table public.clients (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  document_number text not null check (length(document_number) > 0),
  full_name text not null,
  phone text,
  address text,
  latitude numeric(9,6),
  longitude numeric(9,6),
  id_front_path text,
  id_back_path text,
  data_consent_accepted boolean not null default false,
  data_consent_at timestamptz,
  data_consent_path text,
  notes text,
  created_by uuid default auth.uid() references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, document_number),
  check (not data_consent_accepted or data_consent_at is not null)
);
create index clients_created_by_idx on public.clients(created_by);

-- ===== Préstamos =====
create table public.loans (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete restrict,
  collector_id uuid not null references public.profiles(id) on delete restrict,
  principal numeric(14,2) not null check (principal > 0),
  interest_rate numeric(7,3) not null check (interest_rate >= 0),
  interest_amount numeric(14,2) not null check (interest_amount >= 0),
  paperwork_daily_fee numeric(14,2) not null check (paperwork_daily_fee >= 0),
  installments_count integer not null check (installments_count > 0),
  installment_amount numeric(14,2) not null,
  daily_payment numeric(14,2) not null,
  total_to_pay numeric(14,2) not null,
  start_date date not null,
  due_date date not null,
  status public.loan_status not null default 'activo',
  disbursement_method public.payment_method not null,
  disbursement_account_id uuid references public.payment_accounts(id),
  disbursed_amount numeric(14,2) not null default 0,
  renewed_from_loan_id uuid references public.loans(id),
  notes text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  closed_at timestamptz,
  check (due_date > start_date)
);
create index loans_org_status_idx on public.loans(organization_id, status);
create index loans_collector_idx on public.loans(collector_id, status);
create index loans_client_idx on public.loans(client_id);
create index loans_renewed_idx on public.loans(renewed_from_loan_id);
create index loans_account_idx on public.loans(disbursement_account_id);
create index loans_created_by_idx on public.loans(created_by);

create table public.loan_installments (
  id uuid primary key default gen_random_uuid(),
  loan_id uuid not null references public.loans(id) on delete cascade,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  number integer not null,
  due_date date not null,
  kind public.installment_kind not null default 'regular',
  principal_due numeric(14,2) not null default 0,
  interest_due numeric(14,2) not null default 0,
  paperwork_due numeric(14,2) not null default 0,
  late_fee_due numeric(14,2) not null default 0,
  principal_paid numeric(14,2) not null default 0,
  interest_paid numeric(14,2) not null default 0,
  paperwork_paid numeric(14,2) not null default 0,
  late_fee_paid numeric(14,2) not null default 0,
  amount_due numeric(14,2) generated always as (principal_due + interest_due + paperwork_due + late_fee_due) stored,
  amount_paid numeric(14,2) generated always as (principal_paid + interest_paid + paperwork_paid + late_fee_paid) stored,
  status public.installment_status not null default 'pendiente',
  created_at timestamptz not null default now(),
  unique (loan_id, number),
  check (principal_paid between 0 and principal_due),
  check (interest_paid between 0 and interest_due),
  check (paperwork_paid between 0 and paperwork_due),
  check (late_fee_paid between 0 and late_fee_due)
);
create unique index loan_installments_extra_uniq on public.loan_installments(loan_id, due_date, kind) where kind <> 'regular';
create index loan_installments_loan_due_idx on public.loan_installments(loan_id, due_date);
create index loan_installments_org_due_idx on public.loan_installments(organization_id, due_date);

create table public.collection_logs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  loan_id uuid not null references public.loans(id) on delete cascade,
  collector_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  type public.log_type not null,
  note text,
  promised_date date,
  log_date date not null default (now() at time zone 'America/Bogota')::date,
  client_uuid uuid unique,
  created_at timestamptz not null default now()
);
create index collection_logs_loan_idx on public.collection_logs(loan_id, log_date);
create index collection_logs_org_idx on public.collection_logs(organization_id, log_date);
create index collection_logs_collector_idx on public.collection_logs(collector_id);

create table public.client_assignment_history (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  loan_id uuid not null references public.loans(id) on delete cascade,
  client_id uuid not null references public.clients(id) on delete cascade,
  from_collector_id uuid references public.profiles(id) on delete set null,
  to_collector_id uuid references public.profiles(id) on delete set null,
  reassigned_by uuid references public.profiles(id) on delete set null,
  reason text,
  created_at timestamptz not null default now()
);
create index cah_org_idx on public.client_assignment_history(organization_id);
create index cah_loan_idx on public.client_assignment_history(loan_id);
create index cah_client_idx on public.client_assignment_history(client_id);
create index cah_from_idx on public.client_assignment_history(from_collector_id);
create index cah_to_idx on public.client_assignment_history(to_collector_id);
create index cah_by_idx on public.client_assignment_history(reassigned_by);

-- ===== Pagos =====
create table public.payments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  loan_id uuid not null references public.loans(id) on delete cascade,
  collector_id uuid not null references public.profiles(id) on delete restrict,
  registered_by uuid references public.profiles(id) on delete set null,
  amount numeric(14,2) not null check (amount > 0),
  method public.payment_method not null,
  payment_account_id uuid references public.payment_accounts(id),
  transfer_reference text,
  receipt_path text,
  verification_status public.verification_status not null default 'no_aplica',
  verified_by uuid references public.profiles(id) on delete set null,
  verified_at timestamptz,
  rejection_reason text,
  paid_at timestamptz not null default now(),
  latitude numeric(9,6),
  longitude numeric(9,6),
  notes text,
  client_uuid uuid unique,
  is_reversed boolean not null default false,
  reversed_at timestamptz,
  reversed_by uuid references public.profiles(id) on delete set null,
  reversal_reason text,
  created_at timestamptz not null default now(),
  check (method <> 'transferencia' or payment_account_id is not null)
);
create unique index payments_transfer_ref_uniq on public.payments(payment_account_id, transfer_reference)
  where transfer_reference is not null and not is_reversed;
create index payments_loan_idx on public.payments(loan_id);
create index payments_collector_idx on public.payments(collector_id, paid_at);
create index payments_org_verif_idx on public.payments(organization_id, verification_status);
create index payments_org_paid_idx on public.payments(organization_id, paid_at);
create index payments_account_idx on public.payments(payment_account_id);
create index payments_registered_idx on public.payments(registered_by);
create index payments_verified_idx on public.payments(verified_by);
create index payments_reversed_idx on public.payments(reversed_by);

create table public.payment_allocations (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  payment_id uuid not null references public.payments(id) on delete cascade,
  installment_id uuid not null references public.loan_installments(id) on delete cascade,
  principal_part numeric(14,2) not null default 0,
  interest_part numeric(14,2) not null default 0,
  paperwork_part numeric(14,2) not null default 0,
  late_fee_part numeric(14,2) not null default 0,
  amount numeric(14,2) generated always as (principal_part + interest_part + paperwork_part + late_fee_part) stored,
  created_at timestamptz not null default now()
);
create index payment_alloc_payment_idx on public.payment_allocations(payment_id);
create index payment_alloc_inst_idx on public.payment_allocations(installment_id);
create index payment_alloc_org_idx on public.payment_allocations(organization_id);

-- ===== Gastos y costos fijos =====
create table public.fixed_costs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  collector_id uuid references public.profiles(id) on delete set null,
  name text not null,
  amount numeric(14,2) not null check (amount > 0),
  frequency public.cost_frequency not null,
  is_active boolean not null default true,
  created_at timestamptz not null default now()
);
create index fixed_costs_org_idx on public.fixed_costs(organization_id);
create index fixed_costs_collector_idx on public.fixed_costs(collector_id);

create table public.expenses (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  collector_id uuid references public.profiles(id) on delete set null,
  fixed_cost_id uuid references public.fixed_costs(id) on delete set null,
  kind public.expense_kind not null,
  category text not null,
  description text,
  amount numeric(14,2) not null check (amount > 0),
  expense_date date not null default (now() at time zone 'America/Bogota')::date,
  receipt_path text,
  client_uuid uuid unique,
  created_by uuid default auth.uid() references public.profiles(id) on delete set null,
  created_at timestamptz not null default now(),
  check (kind <> 'eventual_cobrador' or collector_id is not null)
);
create index expenses_org_date_idx on public.expenses(organization_id, expense_date);
create index expenses_collector_idx on public.expenses(collector_id, expense_date);
create index expenses_fixed_idx on public.expenses(fixed_cost_id);
create index expenses_created_by_idx on public.expenses(created_by);

-- ===== Cuadre de caja =====
create table public.cash_closures (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  collector_id uuid not null references public.profiles(id) on delete restrict,
  closure_date date not null,
  cash_collected numeric(14,2) not null default 0,
  transfers_collector_accounts numeric(14,2) not null default 0,
  transfers_org_accounts numeric(14,2) not null default 0,
  cash_disbursed numeric(14,2) not null default 0,
  expenses_total numeric(14,2) not null default 0,
  cash_expected numeric(14,2) not null,
  cash_reported numeric(14,2) not null,
  difference numeric(14,2) generated always as (cash_reported - cash_expected) stored,
  cash_handed_over numeric(14,2) not null default 0,
  adjustment_applied boolean not null default false,
  notes text,
  closed_by uuid references public.profiles(id) on delete set null,
  closed_at timestamptz not null default now(),
  unique (collector_id, closure_date)
);
create index cash_closures_org_idx on public.cash_closures(organization_id, closure_date);
create index cash_closures_by_idx on public.cash_closures(closed_by);

-- ===== Libro de capital =====
create table public.capital_movements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  type public.movement_type not null,
  amount numeric(14,2) not null check (amount <> 0),
  wallet_collector_id uuid references public.profiles(id) on delete restrict,
  wallet_account_id uuid references public.payment_accounts(id) on delete restrict,
  transfer_group uuid,
  loan_id uuid references public.loans(id) on delete set null,
  payment_id uuid references public.payments(id) on delete set null,
  expense_id uuid references public.expenses(id) on delete set null,
  cash_closure_id uuid references public.cash_closures(id) on delete set null,
  note text,
  created_by uuid references public.profiles(id) on delete set null,
  created_at timestamptz not null default now()
);
create index capital_mov_wallet_idx on public.capital_movements(organization_id, wallet_collector_id, wallet_account_id);
create index capital_mov_collector_idx on public.capital_movements(wallet_collector_id, created_at);
create index capital_mov_account_idx on public.capital_movements(wallet_account_id);
create index capital_mov_loan_idx on public.capital_movements(loan_id);
create index capital_mov_payment_idx on public.capital_movements(payment_id);
create index capital_mov_expense_idx on public.capital_movements(expense_id);
create index capital_mov_closure_idx on public.capital_movements(cash_closure_id);
create index capital_mov_created_by_idx on public.capital_movements(created_by);

-- ===== Notificaciones =====
create table public.notifications (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  recipient_id uuid not null references public.profiles(id) on delete cascade,
  type text not null,
  title text not null,
  body text,
  data jsonb not null default '{}'::jsonb,
  read_at timestamptz,
  created_at timestamptz not null default now()
);
create index notifications_recipient_idx on public.notifications(recipient_id, read_at, created_at desc);
create index notifications_org_idx on public.notifications(organization_id);

create table public.push_subscriptions (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null default auth.uid() references public.profiles(id) on delete cascade,
  endpoint text not null unique,
  p256dh text not null,
  auth_key text not null,
  user_agent text,
  created_at timestamptz not null default now()
);
create index push_subscriptions_user_idx on public.push_subscriptions(user_id);

-- ===== Triggers de updated_at =====
create trigger trg_org_updated before update on public.organizations for each row execute function app.set_updated_at();
create trigger trg_profiles_updated before update on public.profiles for each row execute function app.set_updated_at();
create trigger trg_settings_updated before update on public.settings for each row execute function app.set_updated_at();
create trigger trg_sched_updated before update on public.collection_schedules for each row execute function app.set_updated_at();
create trigger trg_clients_updated before update on public.clients for each row execute function app.set_updated_at();
create trigger trg_loans_updated before update on public.loans for each row execute function app.set_updated_at();

-- Normalización de cédula y fecha de autorización de datos
create or replace function app.on_client_write() returns trigger
language plpgsql set search_path = '' as $$
begin
  new.document_number := upper(regexp_replace(coalesce(new.document_number,''), '[^0-9A-Za-z]', '', 'g'));
  if new.data_consent_accepted and new.data_consent_at is null then
    new.data_consent_at := now();
  end if;
  return new;
end $$;
create trigger trg_clients_normalize before insert or update on public.clients
  for each row execute function app.on_client_write();
