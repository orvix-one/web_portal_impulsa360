begin;

-- Mantener el rol unico compatible y permitir facturador.
alter table public.activadores
  drop constraint if exists activadores_rol_check;

alter table public.activadores
  add constraint activadores_rol_check
  check (
    rol in ('administrador', 'lider', 'activador', 'facturador', 'banco')
  );

create table if not exists public.activador_roles (
  usuario_id uuid not null
    references public.activadores(usuario_id) on delete cascade,
  rol text not null,
  primary key (usuario_id, rol),
  constraint activador_roles_rol_check
    check (
      rol in ('administrador', 'lider', 'activador', 'facturador', 'banco')
    )
);

alter table public.activador_roles enable row level security;

-- Los clientes no pueden consultar ni modificar directamente esta tabla.
revoke all on table public.activador_roles
  from public, anon, authenticated;

-- El backend administra las asignaciones mediante service_role.
grant select, insert, update, delete
  on table public.activador_roles to service_role;

-- Copia inicial sin modificar rol ni puede_activar en activadores.
insert into public.activador_roles (usuario_id, rol)
select usuario_id, rol
from public.activadores
on conflict (usuario_id, rol) do nothing;

commit;
