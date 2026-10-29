alter table public.equipos
  alter column facturador_id drop not null;


drop index if exists public.ux_equipos_fallback_facturador_plaza;

create unique index if not exists ux_equipos_fallback_facturador_plaza
  on public.equipos(plaza_id)
  where nombre = 'Equipo sin asignar'
    and facturador_id is null;


/*
 * El historial debe conservar la plaza que tenia el equipo
 * en el momento de cada asignacion.
 *
 * Por eso equipo_lider_historial no debe depender de la
 * combinacion actual (equipo_id, plaza_id) de equipos.
 */
do $$
declare
  v_constraint_name text;
begin
  select c.conname
    into v_constraint_name
  from pg_constraint c
  join pg_class t
    on t.oid = c.conrelid
  join pg_namespace n
    on n.oid = t.relnamespace
  where n.nspname = 'public'
    and t.relname = 'equipo_lider_historial'
    and c.contype = 'f'
    and pg_get_constraintdef(c.oid)
      like 'FOREIGN KEY (equipo_id, plaza_id)%'
  limit 1;

  if v_constraint_name is not null then
    execute format(
      'alter table public.equipo_lider_historial drop constraint %I',
      v_constraint_name
    );
  end if;
end
$$;


/*
 * El historial sigue dependiendo del equipo,
 * pero la plaza historica puede ser distinta de la plaza actual.
 */
do $$
begin
  if not exists (
    select 1
    from pg_constraint c
    join pg_class t
      on t.oid = c.conrelid
    join pg_namespace n
      on n.oid = t.relnamespace
    where n.nspname = 'public'
      and t.relname = 'equipo_lider_historial'
      and c.contype = 'f'
      and pg_get_constraintdef(c.oid)
        like 'FOREIGN KEY (equipo_id) REFERENCES equipos(id)%'
  ) then
    alter table public.equipo_lider_historial
      add constraint equipo_lider_historial_equipo_id_fkey
      foreign key (equipo_id)
      references public.equipos(id);
  end if;
end
$$;


/*
 * Eliminar firmas anteriores de la RPC.
 */
drop function if exists public.actualizar_equipo_organizacion(
  uuid,
  text,
  uuid,
  uuid,
  boolean,
  timestamptz,
  text
);

drop function if exists public.actualizar_equipo_organizacion(
  uuid,
  bigint,
  text,
  uuid,
  uuid,
  boolean,
  timestamptz,
  text
);

drop function if exists public.actualizar_equipo_organizacion(
  uuid,
  bigint,
  text,
  uuid,
  uuid,
  uuid,
  boolean,
  timestamptz,
  text
);


/*
 * Actualiza la organizacion completa de un equipo.
 *
 * Permite modificar:
 * - numero
 * - nombre
 * - plaza
 * - facturador
 * - lider
 * - estado
 */
create or replace function public.actualizar_equipo_organizacion(
  p_equipo_id uuid,
  p_numero bigint,
  p_nombre text,
  p_plaza_id uuid,
  p_facturador_id uuid,
  p_lider_id uuid,
  p_activo boolean,
  p_inicio timestamptz default now(),
  p_motivo text default null
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_equipo public.equipos%rowtype;
  v_lider_final uuid;
  v_plaza_nombre text;
  v_cambio_historial boolean;
begin

  /*
   * Bloquear el equipo durante la operacion.
   */
  select *
    into v_equipo
  from public.equipos
  where id = p_equipo_id
  for update;

  if v_equipo.id is null then
    raise exception 'El equipo no existe';
  end if;


  /*
   * Validar numero.
   */
  if p_numero is null or p_numero <= 0 then
    raise exception 'El numero de equipo es obligatorio';
  end if;

  if exists (
    select 1
    from public.equipos
    where id <> p_equipo_id
      and numero = p_numero
  ) then
    raise exception 'Ya existe un equipo con ese numero';
  end if;


  /*
   * Validar nombre.
   */
  if nullif(btrim(p_nombre), '') is null then
    raise exception 'El nombre es obligatorio';
  end if;


  /*
   * Plaza obligatoria y activa.
   */
  if p_plaza_id is null then
    raise exception 'La plaza es obligatoria';
  end if;

  select nombre
    into v_plaza_nombre
  from public.plazas
  where id = p_plaza_id
    and activa = true;

  if v_plaza_nombre is null then
    raise exception 'La plaza no existe o esta inactiva';
  end if;


  /*
   * Facturador opcional.
   *
   * NULL significa quitar el facturador actual.
   */
  if p_facturador_id is not null
     and not exists (
       select 1
       from public.facturadores
       where id = p_facturador_id
         and activo = true
     )
  then
    raise exception 'El facturador no existe o esta inactivo';
  end if;


  /*
   * Un equipo inactivo no conserva lider actual.
   */
  v_lider_final :=
    case
      when p_activo then p_lider_id
      else null
    end;


  /*
   * Validar lider mediante activador_roles.
   * Compatible con usuarios multirole.
   */
  if v_lider_final is not null
     and not exists (
       select 1
       from public.activadores a
       join public.activador_roles ar
         on ar.usuario_id = a.usuario_id
        and ar.rol = 'lider'
       where a.usuario_id = v_lider_final
         and a.estado = 'activo'
     )
  then
    raise exception 'El lider no existe o esta inactivo';
  end if;


  /*
   * Se crea un nuevo periodo historico cuando cambia:
   * - lider
   * - plaza
   * - estado
   */
  v_cambio_historial :=
       v_equipo.lider_actual_id is distinct from v_lider_final
    or v_equipo.plaza_id is distinct from p_plaza_id
    or v_equipo.activo is distinct from p_activo;


  /*
   * Cerrar historial vigente antes de cambiar
   * la organizacion actual.
   */
  if v_cambio_historial then
    update public.equipo_lider_historial
    set fin = p_inicio
    where equipo_id = p_equipo_id
      and fin is null
      and inicio < p_inicio;
  end if;


  /*
   * Actualizar equipo.
   *
   * IMPORTANTE:
   * no utilizar COALESCE en facturador_id.
   * NULL debe poder quitar el facturador.
   */
  update public.equipos
  set
    numero = p_numero,
    nombre = btrim(p_nombre),
    plaza_id = p_plaza_id,
    facturador_id = p_facturador_id,
    lider_actual_id = v_lider_final,
    activo = p_activo
  where id = p_equipo_id;


  /*
   * Abrir nuevo periodo historico utilizando
   * la NUEVA plaza.
   */
  if v_cambio_historial
     and v_lider_final is not null
  then
    insert into public.equipo_lider_historial (
      equipo_id,
      plaza_id,
      lider_id,
      inicio,
      autorizado_por,
      motivo
    )
    values (
      p_equipo_id,
      p_plaza_id,
      v_lider_final,
      p_inicio,
      auth.uid(),
      p_motivo
    );
  end if;


  /*
   * Sincronizar los integrantes actuales del equipo.
   *
   * Se identifica al activador mediante activador_roles,
   * no mediante activadores.rol, para soportar multirole.
   */
  update public.activadores a
  set
    lider_id = v_lider_final,
    plaza_id = p_plaza_id,
    plaza = v_plaza_nombre,
    plaza_base = v_plaza_nombre
  where a.equipo_id = p_equipo_id
    and exists (
      select 1
      from public.activador_roles ar
      where ar.usuario_id = a.usuario_id
        and ar.rol = 'activador'
    );

end;
$$;


/*
 * La RPC administrativa solo puede ejecutarse
 * mediante service_role.
 */
revoke all
on function public.actualizar_equipo_organizacion(
  uuid,
  bigint,
  text,
  uuid,
  uuid,
  uuid,
  boolean,
  timestamptz,
  text
)
from public, anon, authenticated;

grant execute
on function public.actualizar_equipo_organizacion(
  uuid,
  bigint,
  text,
  uuid,
  uuid,
  uuid,
  boolean,
  timestamptz,
  text
)
to service_role;