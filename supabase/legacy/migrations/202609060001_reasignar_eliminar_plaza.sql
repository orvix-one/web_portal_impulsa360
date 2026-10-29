create or replace function public.reasignar_y_eliminar_plaza(p_plaza_origen uuid, p_plaza_destino uuid)
returns jsonb language plpgsql security definer set search_path = public as $$
declare v_origen public.plazas%rowtype; v_destino public.plazas%rowtype;
begin
  if p_plaza_origen = p_plaza_destino then raise exception 'La plaza de destino debe ser distinta'; end if;
  select * into v_origen from public.plazas where id = p_plaza_origen for update;
  if v_origen.id is null then raise exception 'La plaza de origen no existe'; end if;
  select * into v_destino from public.plazas where id = p_plaza_destino and activa for update;
  if v_destino.id is null then raise exception 'La plaza de destino no existe o esta inactiva'; end if;
  if exists (select 1 from public.equipo_lider_historial where plaza_id = p_plaza_origen)
     or exists (select 1 from public.activaciones where plaza_id_registro = p_plaza_origen or plaza_base_id_registro = p_plaza_origen or plaza_efectiva_id_registro = p_plaza_origen)
  then raise exception 'No se puede reasignar de forma segura: existe historial o activaciones históricas vinculadas. Debe deshabilitarse.'; end if;
  update public.equipos set plaza_id = p_plaza_destino where plaza_id = p_plaza_origen;
  update public.activadores set plaza_id = p_plaza_destino, plaza_base = v_destino.nombre, plaza = v_destino.nombre where plaza_id = p_plaza_origen;
  update public.activador_plaza_temporal set plaza_temporal_id = p_plaza_destino where plaza_temporal_id = p_plaza_origen;
  delete from public.plazas where id = p_plaza_origen;
  return jsonb_build_object('equipos', (select count(*) from public.equipos where plaza_id = p_plaza_destino), 'plaza_destino', p_plaza_destino);
end $$;

revoke all on function public.reasignar_y_eliminar_plaza(uuid,uuid) from public, anon, authenticated;
grant execute on function public.reasignar_y_eliminar_plaza(uuid,uuid) to service_role;
