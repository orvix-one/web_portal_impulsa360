alter table public.facturadores
  add column if not exists usuario_id uuid;

alter table public.facturadores
  drop constraint if exists facturadores_usuario_id_fkey;

alter table public.facturadores
  add constraint facturadores_usuario_id_fkey
  foreign key (usuario_id)
  references public.activadores(usuario_id)
  on delete set null;

create unique index if not exists ux_facturadores_usuario_id
  on public.facturadores(usuario_id)
  where usuario_id is not null;
