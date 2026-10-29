alter table public.equipo_lider_historial
  drop constraint if exists equipo_lider_equipo_plaza_fk;

alter table public.equipo_lider_historial
  add constraint equipo_lider_equipo_plaza_fk
  foreign key (equipo_id, plaza_id)
  references public.equipos(id, plaza_id)
  on delete restrict
  deferrable initially immediate;

create or replace function public.reasignar_y_eliminar_plaza(p_plaza_origen uuid, p_plaza_destino uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_origen public.plazas%rowtype;
  v_destino public.plazas%rowtype;
  v_equipos integer := 0;
  v_equipo_historial integer := 0;
  v_activadores integer := 0;
  v_plazas_temporales integer := 0;
  v_activaciones integer := 0;
begin
  if p_plaza_origen = p_plaza_destino then
    raise exception 'La plaza de destino debe ser distinta';
  end if;

  select *
    into v_origen
  from public.plazas
  where id = p_plaza_origen
  for update;

  if v_origen.id is null then
    raise exception 'La plaza de origen no existe';
  end if;

  select *
    into v_destino
  from public.plazas
  where id = p_plaza_destino
    and activa
  for update;

  if v_destino.id is null then
    raise exception 'La plaza de destino no existe o esta inactiva';
  end if;

  if exists (
    select 1
    from public.equipos eo
    join public.equipos ed
      on ed.facturador_id = eo.facturador_id
     and ed.plaza_id = p_plaza_destino
     and ed.nombre = 'Equipo sin asignar'
    where eo.plaza_id = p_plaza_origen
      and eo.nombre = 'Equipo sin asignar'
  ) then
    raise exception 'No se puede reasignar: ya existe un equipo sin asignar para el mismo facturador en la plaza destino';
  end if;

  if exists (
    select 1
    from public.equipos eo
    join public.equipos ed
      on ed.lider_actual_id = eo.lider_actual_id
     and ed.plaza_id = p_plaza_destino
     and ed.activo
    where eo.plaza_id = p_plaza_origen
      and eo.activo
      and eo.lider_actual_id is not null
  ) then
    raise exception 'No se puede reasignar: un lider quedaria con dos equipos activos en la plaza destino';
  end if;

  if exists (
    select 1
    from public.equipo_lider_historial ho
    join public.equipo_lider_historial hd
      on hd.lider_id = ho.lider_id
     and hd.plaza_id = p_plaza_destino
     and tstzrange(hd.inicio, hd.fin, '[)'::text) && tstzrange(ho.inicio, ho.fin, '[)'::text)
    where ho.plaza_id = p_plaza_origen
  ) then
    raise exception 'No se puede reasignar: un lider quedaria con periodos solapados en la plaza destino';
  end if;

  set constraints equipo_lider_equipo_plaza_fk deferred;

  update public.equipo_lider_historial
  set plaza_id = p_plaza_destino
  where plaza_id = p_plaza_origen;
  get diagnostics v_equipo_historial = row_count;

  update public.equipos
  set plaza_id = p_plaza_destino
  where plaza_id = p_plaza_origen;
  get diagnostics v_equipos = row_count;

  update public.activadores
  set plaza_id = p_plaza_destino,
      plaza = v_destino.nombre,
      plaza_base = v_destino.nombre
  where plaza_id = p_plaza_origen;
  get diagnostics v_activadores = row_count;

  update public.activador_plaza_temporal
  set plaza_temporal_id = p_plaza_destino,
      plaza_temporal = v_destino.nombre
  where plaza_temporal_id = p_plaza_origen;
  get diagnostics v_plazas_temporales = row_count;

  update public.activaciones
  set plaza_id_registro = case
        when plaza_id_registro = p_plaza_origen then p_plaza_destino
        else plaza_id_registro
      end,
      plaza_base_id_registro = case
        when plaza_base_id_registro = p_plaza_origen then p_plaza_destino
        else plaza_base_id_registro
      end,
      plaza_efectiva_id_registro = case
        when plaza_efectiva_id_registro = p_plaza_origen then p_plaza_destino
        else plaza_efectiva_id_registro
      end,
      plaza = case
        when plaza_id_registro = p_plaza_origen
          then v_destino.nombre
        else plaza
      end,
      plaza_temporal = case
        when plaza_efectiva_id_registro = p_plaza_origen
          and plaza_temporal_registro
          then v_destino.nombre
        else plaza_temporal
      end,
      plaza_base_registro = case
        when plaza_base_id_registro = p_plaza_origen
          then v_destino.nombre
        else plaza_base_registro
      end,
      plaza_efectiva_registro = case
        when plaza_efectiva_id_registro = p_plaza_origen
          then v_destino.nombre
        else plaza_efectiva_registro
      end
  where plaza_id_registro = p_plaza_origen
     or plaza_base_id_registro = p_plaza_origen
     or plaza_efectiva_id_registro = p_plaza_origen;
  get diagnostics v_activaciones = row_count;

  if exists (select 1 from public.equipos where plaza_id = p_plaza_origen) then
    raise exception 'No se puede eliminar la plaza origen: quedan equipos vinculados';
  end if;

  if exists (select 1 from public.activadores where plaza_id = p_plaza_origen) then
    raise exception 'No se puede eliminar la plaza origen: quedan activadores vinculados';
  end if;

  if exists (select 1 from public.activador_plaza_temporal where plaza_temporal_id = p_plaza_origen) then
    raise exception 'No se puede eliminar la plaza origen: quedan plazas temporales vinculadas';
  end if;

  if exists (select 1 from public.equipo_lider_historial where plaza_id = p_plaza_origen) then
    raise exception 'No se puede eliminar la plaza origen: queda historial de lideres vinculado';
  end if;

  if exists (
    select 1
    from public.activaciones
    where plaza_id_registro = p_plaza_origen
       or plaza_base_id_registro = p_plaza_origen
       or plaza_efectiva_id_registro = p_plaza_origen
  ) then
    raise exception 'No se puede eliminar la plaza origen: quedan activaciones vinculadas';
  end if;

  delete from public.plazas
  where id = p_plaza_origen;

  return jsonb_build_object(
    'plaza_origen_eliminada', p_plaza_origen,
    'plaza_destino', p_plaza_destino,
    'equipos_reasignados', v_equipos,
    'equipo_lider_historial_reasignados', v_equipo_historial,
    'activadores_reasignados', v_activadores,
    'plazas_temporales_reasignadas', v_plazas_temporales,
    'activaciones_reasignadas', v_activaciones
  );
end;
$$;

revoke all on function public.reasignar_y_eliminar_plaza(uuid,uuid) from public, anon, authenticated;
grant execute on function public.reasignar_y_eliminar_plaza(uuid,uuid) to service_role;
