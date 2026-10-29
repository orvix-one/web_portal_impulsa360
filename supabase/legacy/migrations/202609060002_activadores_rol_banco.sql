alter table public.activadores
  drop constraint if exists activadores_rol_check;

alter table public.activadores
  add constraint activadores_rol_check
  check (rol = any (array['activador'::text, 'lider'::text, 'administrador'::text, 'banco'::text]));
