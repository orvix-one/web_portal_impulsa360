revoke insert, update, delete on table public.activadores from anon;
revoke insert, update, delete on table public.activadores from authenticated;

revoke insert, update, delete on table public.activaciones from anon;
revoke delete on table public.activaciones from authenticated;

alter table public.activadores enable row level security;
alter table public.activaciones enable row level security;

drop policy if exists activadores_select_own_profile on public.activadores;
create policy activadores_select_own_profile
  on public.activadores
  for select
  to authenticated
  using (usuario_id = auth.uid());

drop policy if exists activaciones_select_own on public.activaciones;
create policy activaciones_select_own
  on public.activaciones
  for select
  to authenticated
  using (usuario_id = auth.uid());

drop policy if exists activaciones_insert_own on public.activaciones;
create policy activaciones_insert_own
  on public.activaciones
  for insert
  to authenticated
  with check (usuario_id = auth.uid());

drop policy if exists activaciones_update_own on public.activaciones;
create policy activaciones_update_own
  on public.activaciones
  for update
  to authenticated
  using (usuario_id = auth.uid())
  with check (usuario_id = auth.uid());
