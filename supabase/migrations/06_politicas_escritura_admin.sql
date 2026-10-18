drop policy sched_admin_write on public.collection_schedules;
create policy sched_admin_insert on public.collection_schedules for insert to authenticated
  with check (organization_id = (select app.current_org_id()) and (select app.is_admin()));
create policy sched_admin_update on public.collection_schedules for update to authenticated
  using (organization_id = (select app.current_org_id()) and (select app.is_admin()))
  with check (organization_id = (select app.current_org_id()));
create policy sched_admin_delete on public.collection_schedules for delete to authenticated
  using (organization_id = (select app.current_org_id()) and (select app.is_admin()));

drop policy fixed_costs_admin_write on public.fixed_costs;
create policy fixed_costs_admin_insert on public.fixed_costs for insert to authenticated
  with check (organization_id = (select app.current_org_id()) and (select app.is_admin()));
create policy fixed_costs_admin_update on public.fixed_costs for update to authenticated
  using (organization_id = (select app.current_org_id()) and (select app.is_admin()))
  with check (organization_id = (select app.current_org_id()));
create policy fixed_costs_admin_delete on public.fixed_costs for delete to authenticated
  using (organization_id = (select app.current_org_id()) and (select app.is_admin()));
