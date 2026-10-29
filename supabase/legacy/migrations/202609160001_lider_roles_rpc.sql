drop index if exists public.ux_equipos_lider_plaza_activo;

alter table public.equipo_lider_historial
  drop constraint if exists lider_plaza_unico_periodo;

create or replace function public.asignar_lider_equipo(
  p_equipo_id uuid, p_lider_id uuid, p_inicio timestamptz default now(), p_motivo text default null
)
returns void language plpgsql security definer set search_path = public
as $$
declare v_plaza_id uuid;
begin
  if not exists (
    select 1
    from public.activadores a
    join public.activador_roles ar on ar.usuario_id = a.usuario_id and ar.rol = 'lider'
    where a.usuario_id = p_lider_id and a.estado = 'activo'
  ) then
    raise exception 'El lider debe existir y estar activo';
  end if;
  select plaza_id into v_plaza_id from public.equipos where id = p_equipo_id and activo;
  if v_plaza_id is null then raise exception 'El equipo no existe o esta inactivo'; end if;
  update public.equipo_lider_historial set fin = p_inicio
  where equipo_id = p_equipo_id and fin is null and inicio < p_inicio;
  insert into public.equipo_lider_historial(equipo_id,plaza_id,lider_id,inicio,autorizado_por,motivo)
  values (p_equipo_id,v_plaza_id,p_lider_id,p_inicio,auth.uid(),p_motivo);
  update public.equipos set lider_actual_id = p_lider_id where id = p_equipo_id;
  update public.activadores a set lider_id = p_lider_id
  where a.equipo_id = p_equipo_id
    and exists (
      select 1 from public.activador_roles ar
      where ar.usuario_id = a.usuario_id and ar.rol = 'activador'
    );
end;
$$;

create or replace function public.asignar_equipos_lider(
  p_lider_id uuid,
  p_equipo_ids uuid[],
  p_inicio timestamptz default now(),
  p_motivo text default null
)
returns void language plpgsql security definer set search_path = public
as $$
declare v_equipo public.equipos%rowtype; v_ids uuid[] := coalesce(p_equipo_ids, array[]::uuid[]);
begin
  if cardinality(v_ids) > 0 and not exists (
    select 1
    from public.activadores a
    join public.activador_roles ar on ar.usuario_id = a.usuario_id and ar.rol = 'lider'
    where a.usuario_id = p_lider_id and a.estado = 'activo'
  ) then
    raise exception 'El lider debe existir y estar activo';
  end if;
  if (select count(*) from public.equipos where id = any(v_ids) and activo) <> cardinality(v_ids) then
    raise exception 'Uno o mas equipos no existen o estan inactivos';
  end if;
  update public.equipo_lider_historial set fin = p_inicio
  where fin is null and inicio < p_inicio
    and (lider_id = p_lider_id or equipo_id = any(v_ids))
    and not (lider_id = p_lider_id and equipo_id = any(v_ids));
  update public.activadores a set lider_id = null
  where a.equipo_id in (
    select id from public.equipos
    where lider_actual_id = p_lider_id and not (id = any(v_ids))
  )
    and exists (
      select 1 from public.activador_roles ar
      where ar.usuario_id = a.usuario_id and ar.rol = 'activador'
    );
  update public.equipos set lider_actual_id = null
  where lider_actual_id = p_lider_id and not (id = any(v_ids));

  for v_equipo in select * from public.equipos where id = any(v_ids) order by numero loop
    if v_equipo.lider_actual_id is distinct from p_lider_id then
      update public.equipo_lider_historial set fin = p_inicio
      where equipo_id = v_equipo.id and fin is null and inicio < p_inicio;
      insert into public.equipo_lider_historial(equipo_id,plaza_id,lider_id,inicio,autorizado_por,motivo)
      values (v_equipo.id,v_equipo.plaza_id,p_lider_id,p_inicio,auth.uid(),p_motivo);
      update public.equipos set lider_actual_id = p_lider_id where id = v_equipo.id;
      update public.activadores a set lider_id = p_lider_id
      where a.equipo_id = v_equipo.id
        and exists (
          select 1 from public.activador_roles ar
          where ar.usuario_id = a.usuario_id and ar.rol = 'activador'
        );
    end if;
  end loop;
end;
$$;

create or replace function public.actualizar_equipo_organizacion(
  p_equipo_id uuid,
  p_nombre text,
  p_facturador_id uuid,
  p_lider_id uuid,
  p_activo boolean,
  p_inicio timestamptz default now(),
  p_motivo text default null
)
returns void language plpgsql security definer set search_path = public
as $$
declare v_equipo public.equipos%rowtype; v_lider_final uuid;
begin
  select * into v_equipo from public.equipos where id = p_equipo_id for update;
  if v_equipo.id is null then raise exception 'El equipo no existe'; end if;
  if nullif(btrim(p_nombre), '') is null then raise exception 'El nombre es obligatorio'; end if;
  if not exists (select 1 from public.facturadores where id = p_facturador_id and activo) then
    raise exception 'El facturador no existe o esta inactivo';
  end if;
  v_lider_final := case when p_activo then p_lider_id else null end;
  if v_lider_final is not null and not exists (
    select 1
    from public.activadores a
    join public.activador_roles ar on ar.usuario_id = a.usuario_id and ar.rol = 'lider'
    where a.usuario_id = v_lider_final and a.estado = 'activo'
  ) then raise exception 'El lider no existe o esta inactivo'; end if;
  if v_equipo.lider_actual_id is distinct from v_lider_final or v_equipo.activo is distinct from p_activo then
    update public.equipo_lider_historial set fin = p_inicio
    where equipo_id = p_equipo_id and fin is null and inicio < p_inicio;
  end if;
  update public.equipos set nombre = btrim(p_nombre), facturador_id = p_facturador_id,
    lider_actual_id = v_lider_final, activo = p_activo
  where id = p_equipo_id;
  if v_lider_final is not null and v_equipo.lider_actual_id is distinct from v_lider_final then
    insert into public.equipo_lider_historial(equipo_id,plaza_id,lider_id,inicio,autorizado_por,motivo)
    values (p_equipo_id,v_equipo.plaza_id,v_lider_final,p_inicio,auth.uid(),p_motivo);
  end if;
  update public.activadores a set lider_id = v_lider_final
  where a.equipo_id = p_equipo_id
    and exists (
      select 1 from public.activador_roles ar
      where ar.usuario_id = a.usuario_id and ar.rol = 'activador'
    );
end;
$$;

revoke all on function public.asignar_lider_equipo(uuid,uuid,timestamptz,text) from public, anon, authenticated;
revoke all on function public.asignar_equipos_lider(uuid,uuid[],timestamptz,text) from public, anon, authenticated;
revoke all on function public.actualizar_equipo_organizacion(uuid,text,uuid,uuid,boolean,timestamptz,text) from public, anon, authenticated;
grant execute on function public.asignar_lider_equipo(uuid,uuid,timestamptz,text) to service_role;
grant execute on function public.asignar_equipos_lider(uuid,uuid[],timestamptz,text) to service_role;
grant execute on function public.actualizar_equipo_organizacion(uuid,text,uuid,uuid,boolean,timestamptz,text) to service_role;
