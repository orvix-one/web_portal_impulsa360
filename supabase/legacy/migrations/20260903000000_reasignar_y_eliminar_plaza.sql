-- Reasignacion transaccional de relaciones operativas de una plaza.
-- Las activaciones y los historiales son inmutables y bloquean el borrado.
create or replace function public.reasignar_y_eliminar_plaza(
  p_plaza_origen uuid,
  p_plaza_destino uuid
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_destino public.plazas%rowtype;
  v_equipos bigint := 0;
  v_activadores bigint := 0;
  v_temporales bigint := 0;
begin
  if p_plaza_origen is null or p_plaza_destino is null or p_plaza_origen = p_plaza_destino then
    raise exception 'La plaza de origen y destino deben existir y ser distintas';
  end if;

  perform 1 from public.plazas where id = p_plaza_origen for update;
  if not found then raise exception 'La plaza de origen no existe'; end if;
  select * into v_destino from public.plazas where id = p_plaza_destino and activa for update;
  if not found then raise exception 'La plaza de destino no existe o esta inactiva'; end if;

  if exists (select 1 from public.equipo_lider_historial where plaza_id = p_plaza_origen)
     or exists (select 1 from public.activaciones where plaza_id_registro = p_plaza_origen or plaza_base_id_registro = p_plaza_origen or plaza_efectiva_id_registro = p_plaza_origen)
  then
    raise exception 'No se puede reasignar de forma segura: existen activaciones o historial vinculados a la plaza';
  end if;

  -- Estas relaciones son operativas actuales; cualquier conflicto de integridad aborta toda la transaccion.
  update public.equipos set plaza_id = p_plaza_destino where plaza_id = p_plaza_origen;
  get diagnostics v_equipos = row_count;
  update public.activadores
    set plaza_id = p_plaza_destino, plaza_base = v_destino.nombre, plaza = v_destino.nombre
    where plaza_id = p_plaza_origen;
  get diagnostics v_activadores = row_count;
  update public.activador_plaza_temporal
    set plaza_temporal_id = p_plaza_destino, plaza_temporal = v_destino.nombre
    where plaza_temporal_id = p_plaza_origen;
  get diagnostics v_temporales = row_count;

  delete from public.plazas where id = p_plaza_origen;
  return jsonb_build_object('equipos', v_equipos, 'activadores', v_activadores, 'temporales', v_temporales);
exception when foreign_key_violation or unique_violation then
  raise exception 'No se puede reasignar de forma segura: existe una relación incompatible con la plaza destino';
end;
$$;

revoke all on function public.reasignar_y_eliminar_plaza(uuid, uuid) from public, anon, authenticated;
grant execute on function public.reasignar_y_eliminar_plaza(uuid, uuid) to service_role;
