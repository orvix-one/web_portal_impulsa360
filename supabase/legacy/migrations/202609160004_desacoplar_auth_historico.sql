-- Estrategia A: desacoplar identidad historica de la cuenta de acceso.
-- activadores.usuario_id queda como identidad historica (PK, NOT NULL, UUID intactos)
-- y deja de referenciar auth.users. El acceso vive en activadores.auth_user_id (NULL
-- = perfil historico sin cuenta). Auditoria re-apuntada al perfil historico.
-- Sin CASCADE, sin DELETE, sin tocar datos historicos salvo backfill 1:1.
-- Migracion versionada de una sola ejecucion. Falla rapido ante huerfanos.
begin;

-- 0. Preflight dentro de la transaccion: abortar si hay referencias huerfanas.
do $$
declare
  v_huerfanos integer;
begin
  select count(*) into v_huerfanos
  from public.equipo_lider_historial h
  where h.autorizado_por is not null
    and not exists (select 1 from public.activadores a where a.usuario_id = h.autorizado_por);
  if v_huerfanos > 0 then
    raise exception 'Preflight: % filas en equipo_lider_historial.autorizado_por sin perfil en activadores', v_huerfanos;
  end if;

  select count(*) into v_huerfanos
  from public.activador_equipo_historial h
  where h.autorizado_por is not null
    and not exists (select 1 from public.activadores a where a.usuario_id = h.autorizado_por);
  if v_huerfanos > 0 then
    raise exception 'Preflight: % filas en activador_equipo_historial.autorizado_por sin perfil en activadores', v_huerfanos;
  end if;

  select count(*) into v_huerfanos
  from public.activador_plaza_temporal h
  where h.autorizado_por is not null
    and not exists (select 1 from public.activadores a where a.usuario_id = h.autorizado_por);
  if v_huerfanos > 0 then
    raise exception 'Preflight: % filas en activador_plaza_temporal.autorizado_por sin perfil en activadores', v_huerfanos;
  end if;

  select count(*) into v_huerfanos
  from public.activador_plaza_temporal h
  where h.cancelado_por is not null
    and not exists (select 1 from public.activadores a where a.usuario_id = h.cancelado_por);
  if v_huerfanos > 0 then
    raise exception 'Preflight: % filas en activador_plaza_temporal.cancelado_por sin perfil en activadores', v_huerfanos;
  end if;
end $$;

-- 1. Columna de acceso (nullable = perfil historico sin cuenta).
alter table public.activadores
  add column if not exists auth_user_id uuid;

-- 2. Backfill 1:1 (unico UPDATE permitido en esta migracion).
update public.activadores
set auth_user_id = usuario_id
where auth_user_id is null;

-- 3. Unicidad del acceso (NULL multiples permitidos: varios historicos sin cuenta).
alter table public.activadores
  add constraint activadores_auth_user_id_key unique (auth_user_id);

-- 4. Soltar FK identidad -> auth (la cuenta deja de estar atada al perfil).
alter table public.activadores
  drop constraint if exists activadores_usuario_id_fkey;

-- 5. Verificar que no persiste ninguna FK de activadores.usuario_id hacia auth.users
-- (si el nombre real difiere del esperado, abortar en vez de seguir bloqueado).
do $$
begin
  if exists (
    select 1
    from pg_constraint con
    join pg_attribute a on a.attrelid = con.conrelid and a.attnum = any (con.conkey)
    join pg_class cref on cref.oid = con.confrelid
    join pg_namespace nref on nref.oid = cref.relnamespace
    where con.contype = 'f'
      and con.conrelid = 'public.activadores'::regclass
      and a.attname = 'usuario_id'
      and nref.nspname = 'auth'
      and cref.relname = 'users'
  ) then
    raise exception 'Preflight: persiste una FK de activadores.usuario_id hacia auth.users con otro nombre; revisar antes de continuar';
  end if;
end $$;

-- 6. Nueva FK de acceso: borrar la cuenta libera el perfil (SET NULL), jamas lo arrastra.
alter table public.activadores
  add constraint activadores_auth_user_id_fkey
  foreign key (auth_user_id)
  references auth.users(id)
  on delete set null;

-- 7. Re-apuntar auditoria al perfil historico (valores, nullability y filas intactos).
alter table public.equipo_lider_historial
  drop constraint if exists equipo_lider_historial_autorizado_por_fkey;
alter table public.equipo_lider_historial
  add constraint equipo_lider_historial_autorizado_por_perfil_fkey
  foreign key (autorizado_por)
  references public.activadores(usuario_id);

alter table public.activador_equipo_historial
  drop constraint if exists activador_equipo_historial_autorizado_por_fkey;
alter table public.activador_equipo_historial
  add constraint activador_equipo_historial_autorizado_por_perfil_fkey
  foreign key (autorizado_por)
  references public.activadores(usuario_id);

alter table public.activador_plaza_temporal
  drop constraint if exists activador_plaza_temporal_autorizado_por_fkey;
alter table public.activador_plaza_temporal
  add constraint activador_plaza_temporal_autorizado_por_perfil_fkey
  foreign key (autorizado_por)
  references public.activadores(usuario_id);

alter table public.activador_plaza_temporal
  drop constraint if exists activador_plaza_temporal_cancelado_por_fkey;
alter table public.activador_plaza_temporal
  add constraint activador_plaza_temporal_cancelado_por_perfil_fkey
  foreign key (cancelado_por)
  references public.activadores(usuario_id);

-- 8. Verificacion final: ninguna de las 4 columnas referencia ya a auth.users.
do $$
begin
  if exists (
    select 1
    from pg_constraint con
    join pg_class c on c.oid = con.conrelid
    join pg_class cref on cref.oid = con.confrelid
    join pg_namespace nref on nref.oid = cref.relnamespace
    where con.contype = 'f'
      and nref.nspname = 'auth'
      and cref.relname = 'users'
      and (
        (c.relname = 'equipo_lider_historial')
        or (c.relname = 'activador_equipo_historial')
        or (c.relname = 'activador_plaza_temporal')
      )
  ) then
    raise exception 'Preflight: persiste una FK de auditoria hacia auth.users; revisar antes de continuar';
  end if;
end $$;

commit;
