-- Baseline of the prod schema (yoloIntegrat360), pg_dump --schema-only --schema=public plus
-- extensions, storage bucket and storage.objects policies. Supersedes supabase/legacy/.
-- Deliberately omitted: grants to role lector_dev (cluster-level role, present only in prod) and
-- default privileges FOR ROLE supabase_admin (managed by Supabase, not changeable by postgres).
-- Prod already contains everything here: mark as applied (migration repair), never push.

create extension if not exists btree_gist with schema public;
create extension if not exists unaccent with schema public;
create extension if not exists pgcrypto with schema extensions;

--
-- PostgreSQL database dump
--


-- Dumped from database version 15.14
-- Dumped by pg_dump version 18.6

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: public; Type: SCHEMA; Schema: -; Owner: -
--

CREATE SCHEMA IF NOT EXISTS public;


--
-- Name: actualizar_equipo_organizacion(uuid, bigint, text, uuid, uuid, uuid, boolean, timestamp with time zone, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.actualizar_equipo_organizacion(p_equipo_id uuid, p_numero bigint, p_nombre text, p_plaza_id uuid, p_facturador_id uuid, p_lider_id uuid, p_activo boolean, p_inicio timestamp with time zone DEFAULT now(), p_motivo text DEFAULT NULL::text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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


--
-- Name: asignar_activador_equipo(uuid, uuid, timestamp with time zone, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.asignar_activador_equipo(p_activador_id uuid, p_equipo_id uuid, p_inicio timestamp with time zone DEFAULT now(), p_motivo text DEFAULT NULL::text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_lider uuid; v_plaza_id uuid; v_plaza_nombre text;
begin
  if not exists (select 1 from public.activadores where usuario_id = p_activador_id and rol = 'activador') then
    raise exception 'El activador no existe';
  end if;
  select e.lider_actual_id, p.id, p.nombre into v_lider, v_plaza_id, v_plaza_nombre
  from public.equipos e join public.plazas p on p.id = e.plaza_id
  where e.id = p_equipo_id and e.activo;
  if v_plaza_id is null then raise exception 'El equipo no existe o esta inactivo'; end if;
  update public.activador_equipo_historial set fin = p_inicio
  where activador_id = p_activador_id and fin is null and inicio < p_inicio;
  insert into public.activador_equipo_historial(activador_id,equipo_id,inicio,autorizado_por,motivo)
  values (p_activador_id,p_equipo_id,p_inicio,auth.uid(),p_motivo);
  update public.activadores set equipo_id = p_equipo_id, lider_id = v_lider,
    plaza_id = v_plaza_id, plaza_base = v_plaza_nombre, plaza = v_plaza_nombre,
    organizacion_pendiente = false
  where usuario_id = p_activador_id;
end;
$$;


--
-- Name: asignar_equipos_lider(uuid, uuid[], timestamp with time zone, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.asignar_equipos_lider(p_lider_id uuid, p_equipo_ids uuid[], p_inicio timestamp with time zone DEFAULT now(), p_motivo text DEFAULT NULL::text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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


--
-- Name: asignar_lider_equipo(uuid, uuid, timestamp with time zone, text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.asignar_lider_equipo(p_equipo_id uuid, p_lider_id uuid, p_inicio timestamp with time zone DEFAULT now(), p_motivo text DEFAULT NULL::text) RETURNS void
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
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


--
-- Name: control_activaciones_detalle(uuid, uuid, date, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.control_activaciones_detalle(p_activador_id uuid, p_equipo_id uuid, p_desde date DEFAULT NULL::date, p_hasta date DEFAULT NULL::date) RETURNS TABLE(id uuid, usuario_id uuid, fecha_activacion date, created_at timestamp with time zone, tipo_activacion text, nombres_cliente text, apellidos_cliente text, plaza text, foto_url text, foto_cash_in text, equipo_id_registro uuid, lider_id_registro uuid)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_usuario_id uuid := auth.uid();
  v_rol text;
  v_estado text;
  v_es_admin boolean;
  v_es_lider boolean;
  v_lider_equipo_id uuid;
  v_equipo_actual_id uuid;
  v_activador_tiene_historial boolean;
begin
  if v_usuario_id is null then
    raise exception using errcode = '42501', message = 'Sesión autenticada requerida.';
  end if;
  if p_activador_id is null or p_equipo_id is null then
    raise exception using errcode = '22004', message = 'Activador y equipo son obligatorios.';
  end if;

  select
    regexp_replace(
      translate(lower(btrim(coalesce(a.rol, ''))), 'áéíóúüñ', 'aeiouun'),
      '[^a-z0-9]+',
      '_',
      'g'
    ),
    lower(btrim(coalesce(a.estado, '')))
  into v_rol, v_estado
  from public.activadores a
  where a.usuario_id = v_usuario_id;

  if not found or v_estado <> 'activo' then
    raise exception using errcode = '42501', message = 'Usuario inexistente o inactivo.';
  end if;

  v_es_admin := v_rol in ('admin', 'administrador', 'administrator')
    or v_rol like 'admin\_%' escape '\'
    or v_rol like 'administrador\_%' escape '\'
    or v_rol like 'administrator\_%' escape '\'
    or exists (
      select 1
      from public.activador_roles ar
      cross join lateral (
        select regexp_replace(
          translate(lower(btrim(coalesce(ar.rol, ''))), 'áéíóúüñ', 'aeiouun'),
          '[^a-z0-9]+',
          '_',
          'g'
        ) as rol_norm
      ) r
      where ar.usuario_id = v_usuario_id
        and (
          r.rol_norm in ('admin', 'administrador', 'administrator')
          or r.rol_norm like 'admin\_%' escape '\'
          or r.rol_norm like 'administrador\_%' escape '\'
          or r.rol_norm like 'administrator\_%' escape '\'
        )
    );
  v_es_lider := v_rol in ('lider', 'leader', 'supervisor', 'lider_activador', 'activador_lider', 'leader_activator', 'activator_leader')
    or v_rol like 'lider\_%' escape '\'
    or v_rol like 'leader\_%' escape '\'
    or v_rol like 'supervisor\_%' escape '\'
    or ((v_rol like '%lider%' or v_rol like '%leader%') and v_rol like '%activador%')
    or exists (
      select 1
      from public.activador_roles ar
      cross join lateral (
        select regexp_replace(
          translate(lower(btrim(coalesce(ar.rol, ''))), 'áéíóúüñ', 'aeiouun'),
          '[^a-z0-9]+',
          '_',
          'g'
        ) as rol_norm
      ) r
      where ar.usuario_id = v_usuario_id
        and (
          r.rol_norm in ('lider', 'leader', 'supervisor', 'lider_activador', 'activador_lider', 'leader_activator', 'activator_leader')
          or r.rol_norm like 'lider\_%' escape '\'
          or r.rol_norm like 'leader\_%' escape '\'
          or r.rol_norm like 'supervisor\_%' escape '\'
          or ((r.rol_norm like '%lider%' or r.rol_norm like '%leader%') and r.rol_norm like '%activador%')
        )
    );

  if not v_es_admin and not v_es_lider then
    raise exception using errcode = '42501', message = 'El usuario no tiene acceso a Control Activadores.';
  end if;

  select h.lider_id
  into v_lider_equipo_id
  from public.equipo_lider_historial h
  join public.equipos e on e.id = h.equipo_id and e.activo = true
  join public.activadores l
    on l.usuario_id = h.lider_id
   and lower(btrim(coalesce(l.estado, ''))) = 'activo'
  where h.equipo_id = p_equipo_id
    and h.fin is null
    and (v_es_admin or h.lider_id = v_usuario_id)
  limit 1;

  if v_lider_equipo_id is null then
    raise exception using errcode = '42501', message = 'El equipo no está dentro del alcance del usuario.';
  end if;

  select
    a.equipo_id,
    exists (
      select 1
      from public.activador_equipo_historial hx
      where hx.activador_id = a.usuario_id
    )
  into v_equipo_actual_id, v_activador_tiene_historial
  from public.activadores a
  where a.usuario_id = p_activador_id
    and lower(btrim(coalesce(a.estado, ''))) = 'activo'
    and (
      exists (
        select 1
        from public.activador_equipo_historial ah
        where ah.activador_id = a.usuario_id
          and ah.equipo_id = p_equipo_id
          and ah.fin is null
      )
      or (
        a.equipo_id = p_equipo_id
        and not exists (
          select 1
          from public.activador_equipo_historial ah
          where ah.activador_id = a.usuario_id
            and ah.fin is null
        )
      )
    );

  if not found then
    raise exception using errcode = '42501', message = 'El activador no pertenece actualmente al equipo solicitado.';
  end if;

  return query
  with activaciones_base as (
    select
      ac.*,
      coalesce(ac.created_at, ac.fecha_activacion::timestamp at time zone 'UTC') as momento
    from public.activaciones ac
    where ac.usuario_id = p_activador_id
      and (p_desde is null or coalesce(ac.fecha_activacion, ac.created_at::date) >= p_desde)
      and (p_hasta is null or coalesce(ac.fecha_activacion, ac.created_at::date) <= p_hasta)
  ),
  activaciones_resueltas as (
    select
      ac.*,
      coalesce(
        ac.equipo_id_registro,
        ah.equipo_id,
        case when not v_activador_tiene_historial then v_equipo_actual_id end
      ) as equipo_atribuido_id,
      coalesce(ac.lider_id_registro, lh.lider_id) as lider_atribuido_id
    from activaciones_base ac
    left join lateral (
      select h.equipo_id
      from public.activador_equipo_historial h
      where ac.equipo_id_registro is null
        and h.activador_id = ac.usuario_id
        and ac.momento >= h.inicio
        and (h.fin is null or ac.momento < h.fin)
      order by h.inicio desc
      limit 1
    ) ah on true
    left join lateral (
      select h.lider_id
      from public.equipo_lider_historial h
      where ac.lider_id_registro is null
        and h.equipo_id = coalesce(
          ac.equipo_id_registro,
          ah.equipo_id,
          case when not v_activador_tiene_historial then v_equipo_actual_id end
        )
        and ac.momento >= h.inicio
        and (h.fin is null or ac.momento < h.fin)
      order by h.inicio desc
      limit 1
    ) lh on true
  )
  select
    ac.id,
    ac.usuario_id,
    ac.fecha_activacion,
    ac.created_at,
    ac.tipo_activacion,
    ac.nombres_cliente,
    ac.apellidos_cliente,
    ac.plaza,
    ac.foto_url,
    ac.foto_cash_in,
    ac.equipo_id_registro,
    ac.lider_id_registro
  from activaciones_resueltas ac
  where ac.equipo_atribuido_id = p_equipo_id
    and ac.lider_atribuido_id = v_lider_equipo_id
  order by coalesce(ac.fecha_activacion, ac.created_at::date) desc, ac.created_at desc;
end;
$$;


--
-- Name: control_activadores_jerarquia(date, date); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.control_activadores_jerarquia(p_desde date DEFAULT NULL::date, p_hasta date DEFAULT NULL::date) RETURNS TABLE(lider_id uuid, lider_nombre text, equipo_id uuid, equipo_numero bigint, equipo_nombre text, activador_id uuid, activador_nombre text, hoy bigint, semana bigint, mes bigint, total bigint)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_usuario_id uuid := auth.uid();
  v_rol text;
  v_estado text;
  v_es_admin boolean;
  v_es_lider boolean;
  v_fecha_referencia date := (now() at time zone 'America/La_Paz')::date;
begin
  if v_usuario_id is null then
    raise exception using errcode = '42501', message = 'Sesión autenticada requerida.';
  end if;

  select
    regexp_replace(
      translate(lower(btrim(coalesce(a.rol, ''))), 'áéíóúüñ', 'aeiouun'),
      '[^a-z0-9]+',
      '_',
      'g'
    ),
    lower(btrim(coalesce(a.estado, '')))
  into v_rol, v_estado
  from public.activadores a
  where a.usuario_id = v_usuario_id;

  if not found or v_estado <> 'activo' then
    raise exception using errcode = '42501', message = 'Usuario inexistente o inactivo.';
  end if;

  v_es_admin := v_rol in ('admin', 'administrador', 'administrator')
    or v_rol like 'admin\_%' escape '\'
    or v_rol like 'administrador\_%' escape '\'
    or v_rol like 'administrator\_%' escape '\'
    or exists (
      select 1
      from public.activador_roles ar
      cross join lateral (
        select regexp_replace(
          translate(lower(btrim(coalesce(ar.rol, ''))), 'áéíóúüñ', 'aeiouun'),
          '[^a-z0-9]+',
          '_',
          'g'
        ) as rol_norm
      ) r
      where ar.usuario_id = v_usuario_id
        and (
          r.rol_norm in ('admin', 'administrador', 'administrator')
          or r.rol_norm like 'admin\_%' escape '\'
          or r.rol_norm like 'administrador\_%' escape '\'
          or r.rol_norm like 'administrator\_%' escape '\'
        )
    );
  v_es_lider := v_rol in ('lider', 'leader', 'supervisor', 'lider_activador', 'activador_lider', 'leader_activator', 'activator_leader')
    or v_rol like 'lider\_%' escape '\'
    or v_rol like 'leader\_%' escape '\'
    or v_rol like 'supervisor\_%' escape '\'
    or ((v_rol like '%lider%' or v_rol like '%leader%') and v_rol like '%activador%')
    or exists (
      select 1
      from public.activador_roles ar
      cross join lateral (
        select regexp_replace(
          translate(lower(btrim(coalesce(ar.rol, ''))), 'áéíóúüñ', 'aeiouun'),
          '[^a-z0-9]+',
          '_',
          'g'
        ) as rol_norm
      ) r
      where ar.usuario_id = v_usuario_id
        and (
          r.rol_norm in ('lider', 'leader', 'supervisor', 'lider_activador', 'activador_lider', 'leader_activator', 'activator_leader')
          or r.rol_norm like 'lider\_%' escape '\'
          or r.rol_norm like 'leader\_%' escape '\'
          or r.rol_norm like 'supervisor\_%' escape '\'
          or ((r.rol_norm like '%lider%' or r.rol_norm like '%leader%') and r.rol_norm like '%activador%')
        )
    );

  if not v_es_admin and not v_es_lider then
    raise exception using errcode = '42501', message = 'El usuario no tiene acceso a Control Activadores.';
  end if;

  return query
  with equipos_alcance as (
    select
      h.lider_id,
      l.nombre as lider_nombre,
      e.id as equipo_id,
      e.numero as equipo_numero,
      e.nombre as equipo_nombre
    from public.equipo_lider_historial h
    join public.equipos e
      on e.id = h.equipo_id
     and e.activo = true
    join public.activadores l
      on l.usuario_id = h.lider_id
     and lower(btrim(coalesce(l.estado, ''))) = 'activo'
    where h.fin is null
      and (v_es_admin or h.lider_id = v_usuario_id)
  ),
  miembros_vigentes as (
    select h.equipo_id, h.activador_id
    from public.activador_equipo_historial h
    where h.fin is null

    union

    select a.equipo_id, a.usuario_id
    from public.activadores a
    where a.equipo_id is not null
      and not exists (
        select 1
        from public.activador_equipo_historial h
        where h.activador_id = a.usuario_id
          and h.fin is null
      )
  ),
  jerarquia as (
    select
      ea.lider_id,
      ea.lider_nombre,
      ea.equipo_id,
      ea.equipo_numero,
      ea.equipo_nombre,
      a.usuario_id as activador_id,
      a.nombre as activador_nombre,
      a.equipo_id as equipo_actual_id
    from equipos_alcance ea
    left join miembros_vigentes mv on mv.equipo_id = ea.equipo_id
    left join public.activadores a
      on a.usuario_id = mv.activador_id
     and lower(btrim(coalesce(a.estado, ''))) = 'activo'
  ),
  activadores_con_historial as (
    select distinct h.activador_id
    from public.activador_equipo_historial h
  ),
  activaciones_base as (
    select
      ac.*,
      j.equipo_actual_id,
      coalesce(ac.created_at, ac.fecha_activacion::timestamp at time zone 'UTC') as momento,
      coalesce(ac.fecha_activacion, ac.created_at::date) as fecha
    from public.activaciones ac
    join (
      select distinct x.activador_id, x.equipo_actual_id
      from jerarquia x
      where x.activador_id is not null
    ) j on j.activador_id = ac.usuario_id
    where (p_desde is null or coalesce(ac.fecha_activacion, ac.created_at::date) >= p_desde)
      and (p_hasta is null or coalesce(ac.fecha_activacion, ac.created_at::date) <= p_hasta)
  ),
  activaciones_resueltas as (
    select
      ac.usuario_id,
      ac.fecha,
      coalesce(
        ac.equipo_id_registro,
        ah.equipo_id,
        case when ch.activador_id is null then ac.equipo_actual_id end
      ) as equipo_atribuido_id,
      coalesce(ac.lider_id_registro, lh.lider_id) as lider_atribuido_id
    from activaciones_base ac
    left join activadores_con_historial ch on ch.activador_id = ac.usuario_id
    left join lateral (
      select h.equipo_id
      from public.activador_equipo_historial h
      where ac.equipo_id_registro is null
        and h.activador_id = ac.usuario_id
        and ac.momento >= h.inicio
        and (h.fin is null or ac.momento < h.fin)
      order by h.inicio desc
      limit 1
    ) ah on true
    left join lateral (
      select h.lider_id
      from public.equipo_lider_historial h
      where ac.lider_id_registro is null
        and h.equipo_id = coalesce(
          ac.equipo_id_registro,
          ah.equipo_id,
          case when ch.activador_id is null then ac.equipo_actual_id end
        )
        and ac.momento >= h.inicio
        and (h.fin is null or ac.momento < h.fin)
      order by h.inicio desc
      limit 1
    ) lh on true
  ),
  metricas as (
    select
      ac.usuario_id,
      ac.equipo_atribuido_id,
      ac.lider_atribuido_id,
      count(*) filter (where ac.fecha = v_fecha_referencia) as hoy,
      count(*) filter (
        where ac.fecha between date_trunc('week', v_fecha_referencia)::date and v_fecha_referencia
      ) as semana,
      count(*) filter (
        where ac.fecha between date_trunc('month', v_fecha_referencia)::date and v_fecha_referencia
      ) as mes,
      count(*) as total
    from activaciones_resueltas ac
    group by ac.usuario_id, ac.equipo_atribuido_id, ac.lider_atribuido_id
  )
  select
    j.lider_id,
    j.lider_nombre,
    j.equipo_id,
    j.equipo_numero,
    j.equipo_nombre,
    j.activador_id,
    j.activador_nombre,
    coalesce(m.hoy, 0)::bigint,
    coalesce(m.semana, 0)::bigint,
    coalesce(m.mes, 0)::bigint,
    coalesce(m.total, 0)::bigint
  from jerarquia j
  left join metricas m
    on m.usuario_id = j.activador_id
   and m.equipo_atribuido_id = j.equipo_id
   and m.lider_atribuido_id = j.lider_id
  order by j.lider_nombre, j.equipo_numero, j.equipo_nombre, j.activador_nombre;
end;
$$;


--
-- Name: normalizar_nombre_plaza(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.normalizar_nombre_plaza() RETURNS trigger
    LANGUAGE plpgsql
    SET search_path TO 'public'
    AS $$
begin
  new.nombre := btrim(new.nombre);
  new.nombre_normalizado := lower(unaccent(btrim(new.nombre)));
  return new;
end;
$$;


--
-- Name: plaza_efectiva_activador(uuid, timestamp with time zone); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.plaza_efectiva_activador(p_activador_id uuid, p_momento timestamp with time zone DEFAULT now()) RETURNS TABLE(plaza_base text, plaza_efectiva text, es_temporal boolean, asignacion_id uuid, plaza_efectiva_id uuid)
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
  select a.plaza_base,
         coalesce(t.plaza_temporal, a.plaza_base),
         t.id is not null,
         t.id,
         coalesce(t.plaza_temporal_id, e.plaza_id)
  from public.activadores a
  left join public.equipos e on e.id = a.equipo_id
  left join lateral (
    select pt.id, pt.plaza_temporal, pt.plaza_temporal_id
    from public.activador_plaza_temporal pt
    where pt.activador_id = a.usuario_id
      and pt.cancelado_at is null
      and p_momento >= pt.inicio and p_momento < pt.fin
    order by pt.inicio desc limit 1
  ) t on true
  where a.usuario_id = p_activador_id
    and (auth.uid() is null or auth.uid() = p_activador_id);
$$;


--
-- Name: puede_leer_foto_activacion_equipo(text); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.puede_leer_foto_activacion_equipo(p_nombre text) RETURNS boolean
    LANGUAGE sql STABLE SECURITY DEFINER
    SET search_path TO ''
    AS $$
  select
    auth.uid() is not null
    and (
      exists (
        select 1
        from public.activadores a
        where a.usuario_id = auth.uid()
          and lower(btrim(coalesce(a.estado, ''))) = 'activo'
          and (
            regexp_replace(
              translate(lower(btrim(coalesce(a.rol, ''))), 'áéíóúüñ', 'aeiouun'),
              '[^a-z0-9]+', '_', 'g'
            ) in ('admin', 'administrador', 'administrator')
            or regexp_replace(
              translate(lower(btrim(coalesce(a.rol, ''))), 'áéíóúüñ', 'aeiouun'),
              '[^a-z0-9]+', '_', 'g'
            ) like 'admin\_%' escape '\'
            or regexp_replace(
              translate(lower(btrim(coalesce(a.rol, ''))), 'áéíóúüñ', 'aeiouun'),
              '[^a-z0-9]+', '_', 'g'
            ) like 'administrador\_%' escape '\'
            or regexp_replace(
              translate(lower(btrim(coalesce(a.rol, ''))), 'áéíóúüñ', 'aeiouun'),
              '[^a-z0-9]+', '_', 'g'
            ) like 'administrator\_%' escape '\'
          )
      )
      or exists (
        select 1
        from public.activadores l
        join public.equipo_lider_historial h
          on h.lider_id = l.usuario_id
         and h.fin is null
        join public.equipos e
          on e.id = h.equipo_id
         and e.activo = true
        where l.usuario_id = auth.uid()
          and lower(btrim(coalesce(l.estado, ''))) = 'activo'
          and (
            regexp_replace(
              translate(lower(btrim(coalesce(l.rol, ''))), 'áéíóúüñ', 'aeiouun'),
              '[^a-z0-9]+', '_', 'g'
            ) in ('lider', 'leader', 'supervisor', 'lider_activador', 'activador_lider', 'leader_activator', 'activator_leader')
            or regexp_replace(
              translate(lower(btrim(coalesce(l.rol, ''))), 'áéíóúüñ', 'aeiouun'),
              '[^a-z0-9]+', '_', 'g'
            ) like 'lider\_%' escape '\'
            or regexp_replace(
              translate(lower(btrim(coalesce(l.rol, ''))), 'áéíóúüñ', 'aeiouun'),
              '[^a-z0-9]+', '_', 'g'
            ) like 'leader\_%' escape '\'
            or regexp_replace(
              translate(lower(btrim(coalesce(l.rol, ''))), 'áéíóúüñ', 'aeiouun'),
              '[^a-z0-9]+', '_', 'g'
            ) like 'supervisor\_%' escape '\'
            or (
              (
                regexp_replace(
                  translate(lower(btrim(coalesce(l.rol, ''))), 'áéíóúüñ', 'aeiouun'),
                  '[^a-z0-9]+', '_', 'g'
                ) like '%lider%'
                or regexp_replace(
                  translate(lower(btrim(coalesce(l.rol, ''))), 'áéíóúüñ', 'aeiouun'),
                  '[^a-z0-9]+', '_', 'g'
                ) like '%leader%'
              )
              and regexp_replace(
                translate(lower(btrim(coalesce(l.rol, ''))), 'áéíóúüñ', 'aeiouun'),
                '[^a-z0-9]+', '_', 'g'
              ) like '%activador%'
            )
          )
          and p_nombre ~ '^activaciones/[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}/'
          and h.equipo_id in (
            select hh.equipo_id
            from public.activador_equipo_historial hh
            where hh.activador_id = split_part(p_nombre, '/', 2)::uuid
              and hh.fin is null
            union
            select a2.equipo_id
            from public.activadores a2
            where a2.usuario_id = split_part(p_nombre, '/', 2)::uuid
              and a2.equipo_id is not null
              and not exists (
                select 1
                from public.activador_equipo_historial hx
                where hx.activador_id = a2.usuario_id
                  and hx.fin is null
              )
          )
      )
    );
$$;


--
-- Name: reasignar_y_eliminar_plaza(uuid, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.reasignar_y_eliminar_plaza(p_plaza_origen uuid, p_plaza_destino uuid) RETURNS jsonb
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare v_destino public.plazas%rowtype; v_reasignados jsonb;
begin
  if p_plaza_origen = p_plaza_destino then raise exception 'La plaza de destino debe ser distinta'; end if;
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


--
-- Name: registrar_cambio_equipo_activador(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.registrar_cambio_equipo_activador() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
begin
  if new.rol = 'activador' and new.equipo_id is not null then
    if tg_op = 'UPDATE' and old.equipo_id is not distinct from new.equipo_id then
      return new;
    end if;
    if exists (
      select 1 from public.activador_equipo_historial
      where activador_id = new.usuario_id and equipo_id = new.equipo_id and fin is null
    ) then
      return new;
    end if;
    update public.activador_equipo_historial set fin = now()
    where activador_id = new.usuario_id and fin is null;
    if not exists (
      select 1 from public.activador_equipo_historial
      where activador_id = new.usuario_id and equipo_id = new.equipo_id and fin is null
    ) then
      insert into public.activador_equipo_historial(activador_id,equipo_id,inicio,autorizado_por,motivo)
      values (new.usuario_id,new.equipo_id,now(),auth.uid(),'Actualizacion de activador');
    end if;
  end if;
  return new;
end;
$$;


--
-- Name: registrar_eventos_telemetria(jsonb); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.registrar_eventos_telemetria(p_eventos jsonb) RETURNS integer
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $_$
declare
  v_n integer := 0;
  v_ins integer := 0;
  v_e jsonb;
  v_event_id uuid;
begin
  if jsonb_typeof(p_eventos) != 'array' then
    raise exception 'batch inválido';
  end if;
  if jsonb_array_length(p_eventos) < 1 or jsonb_array_length(p_eventos) > 20 then
    raise exception 'batch debe tener entre 1 y 20 eventos';
  end if;
  for v_e in select * from jsonb_array_elements(p_eventos) loop
    if not (v_e->>'event_name' in (
      'app_start','app_background','app_foreground','form_edit',
      'draft_write_ok','draft_write_error',
      'photo_process_start','photo_process_ok','photo_process_error',
      'sync_start','sync_upload_start','sync_upload_ok','sync_upload_error','sync_end',
      'auth_change','logout','error_boundary','previous_run_unclean'
    )) then
      raise exception 'evento inválido';
    end if;
    -- event_id inválido o ausente => NULL (comportamiento legacy, sin conflicto).
    v_event_id := case
      when v_e->>'event_id' ~ '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$'
      then (v_e->>'event_id')::uuid
      else null
    end;
    insert into public.telemetria_eventos (
      usuario_id, event_id, event_name, occurred_at, run_id, app_version, build_number,
      platform, os_version, app_state, screen, phase,
      pending_count_bucket, photo_size_bucket, sync_stage, error_category,
      native_exit_reason, previous_last_state, exit_timestamp, occurrence_count
    ) values (
      auth.uid(),
      v_event_id,
      left(coalesce(v_e->>'event_name',''), 32),
      nullif(v_e->>'occurred_at','')::timestamptz,
      left(coalesce(v_e->>'run_id',''), 64),
      left(coalesce(v_e->>'app_version',''), 32),
      left(coalesce(v_e->>'build_number',''), 32),
      case when v_e->>'platform' in ('android','ios','web') then v_e->>'platform' else 'android' end,
      left(coalesce(v_e->>'os_version',''), 16),
      left(coalesce(v_e->>'app_state','unknown'), 16),
      left(coalesce(v_e->>'screen',''), 32),
      left(coalesce(v_e->>'phase',''), 32),
      case when v_e->>'pending_count_bucket' in ('0','1','2-5','6-20','>20') then v_e->>'pending_count_bucket' else null end,
      left(coalesce(v_e->>'photo_size_bucket',''), 8),
      left(coalesce(v_e->>'sync_stage',''), 32),
      left(coalesce(v_e->>'error_category',''), 32),
      case when v_e->>'native_exit_reason' in ('CRASH','CRASH_NATIVE','ANR','LOW_MEMORY','USER_REQUESTED','OTHER','UNSUPPORTED') then v_e->>'native_exit_reason' else null end,
      nullif(left(coalesce(v_e->>'previous_last_state',''), 16), ''),
      nullif(v_e->>'exit_timestamp','')::timestamptz,
      least(greatest(coalesce((v_e->>'occurrence_count')::integer, 1), 1), 1000)
    )
    on conflict (usuario_id, event_id) do nothing;
    get diagnostics v_ins = row_count;
    v_n := v_n + v_ins;
  end loop;
  return v_n;
end;
$_$;


--
-- Name: snapshot_organizacion_activacion(); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.snapshot_organizacion_activacion() RETURNS trigger
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO 'public'
    AS $$
declare
  v_momento timestamptz := coalesce(new.created_at, now());
  v_equipo public.equipos%rowtype;
  v_lider_id uuid;
  v_plaza record;
begin
  -- Una importacion que ya trae identidad de equipo conserva su snapshot y completa sus IDs de plaza.
  if new.equipo_id_registro is not null then
    select plaza_id into new.plaza_base_id_registro
    from public.equipos where id = new.equipo_id_registro;
    select id into new.plaza_efectiva_id_registro from public.plazas
    where nombre_normalizado = lower(unaccent(btrim(
      coalesce(new.plaza_efectiva_registro, new.plaza_temporal, new.ciudad_activacion)
    )));
    new.plaza_efectiva_id_registro := coalesce(new.plaza_efectiva_id_registro, new.plaza_base_id_registro);
    new.plaza_id_registro := coalesce(new.plaza_id_registro, new.plaza_efectiva_id_registro);
    return new;
  end if;
  select e.* into v_equipo
  from public.activador_equipo_historial h
  join public.equipos e on e.id = h.equipo_id
  where h.activador_id = new.usuario_id
    and v_momento >= h.inicio and (h.fin is null or v_momento < h.fin)
  order by h.inicio desc limit 1;

  if v_equipo.id is null then
    select e.* into v_equipo from public.activadores a join public.equipos e on e.id = a.equipo_id
    where a.usuario_id = new.usuario_id;
  end if;

  select h.lider_id into v_lider_id from public.equipo_lider_historial h
  where h.equipo_id = v_equipo.id
    and v_momento >= h.inicio and (h.fin is null or v_momento < h.fin)
  order by h.inicio desc limit 1;

  select * into v_plaza from public.plaza_efectiva_activador(new.usuario_id, v_momento);
  new.equipo_id_registro := v_equipo.id;
  new.plaza_base_id_registro := v_equipo.plaza_id;
  new.plaza_efectiva_id_registro := coalesce(v_plaza.plaza_efectiva_id, v_equipo.plaza_id);
  new.plaza_id_registro := new.plaza_efectiva_id_registro;
  new.equipo_numero_registro := v_equipo.numero;
  new.equipo_nombre_registro := v_equipo.nombre;
  new.facturador_id_registro := v_equipo.facturador_id;
  select nombre into new.facturador_nombre_registro from public.facturadores where id = v_equipo.facturador_id;
  new.lider_id_registro := coalesce(v_lider_id, v_equipo.lider_actual_id);
  select nombre into new.lider_nombre_registro from public.activadores where usuario_id = new.lider_id_registro;
  new.plaza_base_registro := v_plaza.plaza_base;
  new.plaza_efectiva_registro := coalesce(v_plaza.plaza_efectiva, new.ciudad_activacion);
  new.plaza_temporal_registro := coalesce(v_plaza.es_temporal, false);
  new.plaza_temporal_asignacion_id := v_plaza.asignacion_id;
  return new;
end;
$$;


--
-- Name: validar_elegibilidad_reactivacion(text, text, text, date, uuid); Type: FUNCTION; Schema: public; Owner: -
--

CREATE FUNCTION public.validar_elegibilidad_reactivacion(p_ci text DEFAULT NULL::text, p_telefono text DEFAULT NULL::text, p_tipo_activacion text DEFAULT NULL::text, p_fecha_referencia date DEFAULT CURRENT_DATE, p_registro_id uuid DEFAULT NULL::uuid) RETURNS TABLE(eligible boolean, reason text, previous_activation_date date)
    LANGUAGE plpgsql SECURITY DEFINER
    SET search_path TO ''
    AS $$
declare
  v_usuario_id uuid := auth.uid();
  v_tipo text := lower(coalesce(p_tipo_activacion, ''));
  v_ci text := upper(regexp_replace(coalesce(p_ci, ''), '[^0-9A-Za-z]', '', 'g'));
  v_telefono_digits text := regexp_replace(coalesce(p_telefono, ''), '\D', '', 'g');
  v_telefono text;
  v_fecha_referencia date := coalesce(p_fecha_referencia, current_date);
  v_limite date;
begin
  if v_usuario_id is null then
    raise exception using errcode = '42501', message = 'Sesión autenticada requerida.';
  end if;

  if not exists (
    select 1
    from public.activadores a
    where a.usuario_id = v_usuario_id
      and lower(btrim(coalesce(a.estado, ''))) = 'activo'
  ) then
    raise exception using errcode = '42501', message = 'Usuario inexistente o inactivo.';
  end if;

  if v_fecha_referencia < current_date - 1 or v_fecha_referencia > current_date + 1 then
    v_fecha_referencia := current_date;
  end if;
  v_limite := v_fecha_referencia - 90;

  if not (v_tipo like 'reactivacion%' or v_tipo = 'reimpresion_qr') then
    return query select true, null::text, null::date;
    return;
  end if;

  v_telefono := case
    when length(v_telefono_digits) > 8 then right(v_telefono_digits, 8)
    else v_telefono_digits
  end;

  if v_ci = '' and v_telefono = '' then
    return query select true, null::text, null::date;
    return;
  end if;

  return query
  with recientes as (
    select
      a.id,
      coalesce(a.fecha_activacion, a.created_at::date) as fecha,
      upper(regexp_replace(coalesce(a.ci_cliente, ''), '[^0-9A-Za-z]', '', 'g')) as ci_norm,
      case
        when length(regexp_replace(coalesce(a.telefono_cliente, ''), '\D', '', 'g')) > 8
          then right(regexp_replace(coalesce(a.telefono_cliente, ''), '\D', '', 'g'), 8)
        else regexp_replace(coalesce(a.telefono_cliente, ''), '\D', '', 'g')
      end as telefono_norm
    from public.activaciones a
    where (p_registro_id is null or a.id <> p_registro_id)
      and coalesce(a.fecha_activacion, a.created_at::date) > v_limite
      and coalesce(a.fecha_activacion, a.created_at::date) <= v_fecha_referencia
  ),
  coincidencia as (
    select r.fecha
    from recientes r
    where (v_ci <> '' and r.ci_norm = v_ci)
       or (v_telefono <> '' and r.telefono_norm = v_telefono)
    order by r.fecha desc
    limit 1
  )
  select
    (c.fecha is null) as eligible,
    case
      when c.fecha is null then null::text
      else 'periodo_minimo_no_cumplido'
    end as reason,
    c.fecha as previous_activation_date
  from (select null::date) base
  left join coincidencia c on true;
end;
$$;


SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: activaciones; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.activaciones (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    impulsador text DEFAULT ''::text,
    fecha_activacion date,
    nombres_cliente text,
    apellidos_cliente text,
    ci_cliente text,
    telefono_cliente text,
    email_cliente text DEFAULT ''::text,
    descargo_app boolean,
    registro boolean,
    cash_in boolean,
    cash_out boolean,
    p2p boolean,
    qr_fisico boolean,
    respaldo boolean,
    hubo_error boolean,
    descripcion_error text,
    tipo_activacion text,
    tamano_tienda text,
    foto_url text,
    creado_en timestamp without time zone DEFAULT now(),
    latitud double precision,
    longitud double precision,
    tipo_comercio text,
    usuario_id uuid,
    plaza text,
    reactivacion_comercio boolean,
    ciudad_activacion text,
    zona_activacion text,
    base_activacion text,
    es_reactivacion boolean,
    foto_respaldo_url text,
    estado_sync text,
    dispositivo text,
    foto_cash_in text,
    tipo_tienda text,
    rubro_comercio text,
    rubro_comercio_otro text,
    comercio_fuera_mercado boolean,
    tipo_error text,
    es_plaza_temporal boolean DEFAULT false NOT NULL,
    plaza_temporal text,
    equipo_id_registro uuid,
    plaza_id_registro uuid,
    plaza_base_id_registro uuid,
    plaza_efectiva_id_registro uuid,
    equipo_numero_registro bigint,
    equipo_nombre_registro text,
    facturador_id_registro uuid,
    facturador_nombre_registro text,
    lider_id_registro uuid,
    lider_nombre_registro text,
    plaza_base_registro text,
    plaza_efectiva_registro text,
    plaza_temporal_registro boolean DEFAULT false NOT NULL,
    plaza_temporal_asignacion_id uuid,
    distrito_gps text,
    region_gps text,
    creditos boolean DEFAULT false NOT NULL,
    remesas boolean DEFAULT false NOT NULL,
    CONSTRAINT activaciones_plaza_temporal_check CHECK (((es_plaza_temporal = false) OR (NULLIF(TRIM(BOTH FROM plaza_temporal), ''::text) IS NOT NULL))),
    CONSTRAINT activaciones_tipo_tienda_check CHECK (((tipo_tienda IS NULL) OR (tipo_tienda = ANY (ARRAY['Pequeña'::text, 'Mediana'::text, 'Grande'::text]))))
);


--
-- Name: activador_equipo_historial; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.activador_equipo_historial (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    activador_id uuid NOT NULL,
    equipo_id uuid NOT NULL,
    inicio timestamp with time zone NOT NULL,
    fin timestamp with time zone,
    autorizado_por uuid,
    motivo text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT activador_equipo_fechas_validas CHECK (((fin IS NULL) OR (fin > inicio)))
);


--
-- Name: activador_plaza_temporal; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.activador_plaza_temporal (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    activador_id uuid NOT NULL,
    plaza_temporal_id uuid NOT NULL,
    plaza_temporal text NOT NULL,
    inicio timestamp with time zone NOT NULL,
    fin timestamp with time zone NOT NULL,
    motivo text NOT NULL,
    autorizado_por uuid NOT NULL,
    cancelado_at timestamp with time zone,
    cancelado_por uuid,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    tipo_zona text DEFAULT 'punto_temporal'::text NOT NULL,
    ciudad_plaza text,
    activo boolean DEFAULT true NOT NULL,
    CONSTRAINT activador_plaza_temporal_motivo_check CHECK ((btrim(motivo) <> ''::text)),
    CONSTRAINT activador_plaza_temporal_plaza_temporal_check CHECK ((btrim(plaza_temporal) <> ''::text)),
    CONSTRAINT activador_plaza_temporal_tipo_zona_check CHECK ((tipo_zona = ANY (ARRAY['universidad'::text, 'feria'::text, 'evento'::text, 'campana'::text, 'punto_temporal'::text]))),
    CONSTRAINT plaza_temporal_fechas_validas CHECK ((fin > inicio))
);


--
-- Name: activador_roles; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.activador_roles (
    usuario_id uuid NOT NULL,
    rol text NOT NULL,
    CONSTRAINT activador_roles_rol_check CHECK ((rol = ANY (ARRAY['administrador'::text, 'lider'::text, 'activador'::text, 'facturador'::text, 'banco'::text])))
);


--
-- Name: activadores; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.activadores (
    usuario_id uuid DEFAULT auth.uid() NOT NULL,
    nombre text NOT NULL,
    email text,
    plaza text,
    estado text DEFAULT 'activo'::text NOT NULL,
    rol text DEFAULT 'activador'::text NOT NULL,
    inhabilitado_at timestamp with time zone,
    motivo_inhabilitacion text,
    lider_id uuid,
    plaza_base text,
    plaza_id uuid,
    organizacion_pendiente boolean DEFAULT false NOT NULL,
    equipo_id uuid,
    puede_activar boolean DEFAULT false NOT NULL,
    auth_user_id uuid,
    CONSTRAINT activadores_estado_check CHECK ((estado = ANY (ARRAY['activo'::text, 'inhabilitado'::text]))),
    CONSTRAINT activadores_rol_check CHECK ((rol = ANY (ARRAY['administrador'::text, 'lider'::text, 'activador'::text, 'facturador'::text, 'banco'::text])))
);


--
-- Name: equipo_lider_historial; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.equipo_lider_historial (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    equipo_id uuid NOT NULL,
    plaza_id uuid NOT NULL,
    lider_id uuid NOT NULL,
    inicio timestamp with time zone NOT NULL,
    fin timestamp with time zone,
    autorizado_por uuid,
    motivo text,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    CONSTRAINT equipo_lider_fechas_validas CHECK (((fin IS NULL) OR (fin > inicio)))
);


--
-- Name: equipos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.equipos (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    numero bigint NOT NULL,
    nombre text NOT NULL,
    facturador_id uuid,
    plaza_id uuid NOT NULL,
    lider_actual_id uuid,
    activo boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: equipos_numero_seq; Type: SEQUENCE; Schema: public; Owner: -
--

ALTER TABLE public.equipos ALTER COLUMN numero ADD GENERATED BY DEFAULT AS IDENTITY (
    SEQUENCE NAME public.equipos_numero_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1
);


--
-- Name: facturadores; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.facturadores (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    codigo text NOT NULL,
    nombre text NOT NULL,
    activo boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    usuario_id uuid
);


--
-- Name: notificaciones; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notificaciones (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    titulo text NOT NULL,
    mensaje text NOT NULL,
    alcance text NOT NULL,
    usuario_objetivo_id uuid,
    creado_por text NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL,
    tipo_audiencia text DEFAULT 'all'::text NOT NULL,
    rol_objetivo text,
    destinatarios_total integer,
    CONSTRAINT notificaciones_alcance_check CHECK ((alcance = ANY (ARRAY['all'::text, 'user'::text]))),
    CONSTRAINT notificaciones_mensaje_check CHECK (((char_length(TRIM(BOTH FROM mensaje)) >= 3) AND (char_length(TRIM(BOTH FROM mensaje)) <= 2000))),
    CONSTRAINT notificaciones_rol_objetivo_valido CHECK (((rol_objetivo IS NULL) OR (rol_objetivo = ANY (ARRAY['activador'::text, 'lider'::text, 'facturador'::text])))),
    CONSTRAINT notificaciones_tipo_audiencia_valido CHECK ((tipo_audiencia = ANY (ARRAY['all'::text, 'role'::text, 'users'::text]))),
    CONSTRAINT notificaciones_titulo_check CHECK (((char_length(TRIM(BOTH FROM titulo)) >= 3) AND (char_length(TRIM(BOTH FROM titulo)) <= 120)))
);


--
-- Name: notificaciones_destinatarios; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.notificaciones_destinatarios (
    notificacion_id uuid NOT NULL,
    usuario_id uuid NOT NULL,
    enviada_at timestamp with time zone DEFAULT now() NOT NULL,
    leida_at timestamp with time zone,
    id uuid DEFAULT gen_random_uuid() NOT NULL
);


--
-- Name: plazas; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.plazas (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    nombre text NOT NULL,
    nombre_normalizado text NOT NULL,
    activa boolean DEFAULT true NOT NULL,
    created_at timestamp with time zone DEFAULT now() NOT NULL
);


--
-- Name: telemetria_eventos; Type: TABLE; Schema: public; Owner: -
--

CREATE TABLE public.telemetria_eventos (
    id uuid DEFAULT gen_random_uuid() NOT NULL,
    usuario_id uuid DEFAULT auth.uid() NOT NULL,
    received_at timestamp with time zone DEFAULT now() NOT NULL,
    event_name text NOT NULL,
    occurred_at timestamp with time zone,
    run_id text,
    app_version text,
    build_number text,
    platform text,
    os_version text,
    app_state text,
    screen text,
    phase text,
    pending_count_bucket text,
    photo_size_bucket text,
    sync_stage text,
    error_category text,
    native_exit_reason text,
    occurrence_count integer DEFAULT 1 NOT NULL,
    event_id uuid,
    exit_timestamp timestamp with time zone,
    previous_last_state text,
    CONSTRAINT telemetria_eventos_app_state_check CHECK ((char_length(app_state) <= 16)),
    CONSTRAINT telemetria_eventos_app_version_check CHECK ((char_length(app_version) <= 32)),
    CONSTRAINT telemetria_eventos_build_number_check CHECK ((char_length(build_number) <= 32)),
    CONSTRAINT telemetria_eventos_error_category_check CHECK ((char_length(error_category) <= 32)),
    CONSTRAINT telemetria_eventos_event_name_check CHECK ((event_name = ANY (ARRAY['app_start'::text, 'app_background'::text, 'app_foreground'::text, 'form_edit'::text, 'draft_write_ok'::text, 'draft_write_error'::text, 'photo_process_start'::text, 'photo_process_ok'::text, 'photo_process_error'::text, 'sync_start'::text, 'sync_upload_start'::text, 'sync_upload_ok'::text, 'sync_upload_error'::text, 'sync_end'::text, 'auth_change'::text, 'logout'::text, 'error_boundary'::text, 'previous_run_unclean'::text]))),
    CONSTRAINT telemetria_eventos_native_exit_reason_check CHECK ((native_exit_reason = ANY (ARRAY['CRASH'::text, 'CRASH_NATIVE'::text, 'ANR'::text, 'LOW_MEMORY'::text, 'USER_REQUESTED'::text, 'OTHER'::text, 'UNSUPPORTED'::text]))),
    CONSTRAINT telemetria_eventos_occurrence_count_check CHECK (((occurrence_count >= 1) AND (occurrence_count <= 1000))),
    CONSTRAINT telemetria_eventos_os_version_check CHECK ((char_length(os_version) <= 16)),
    CONSTRAINT telemetria_eventos_pending_count_bucket_check CHECK ((pending_count_bucket = ANY (ARRAY['0'::text, '1'::text, '2-5'::text, '6-20'::text, '>20'::text]))),
    CONSTRAINT telemetria_eventos_phase_check CHECK ((char_length(phase) <= 32)),
    CONSTRAINT telemetria_eventos_photo_size_bucket_check CHECK ((char_length(photo_size_bucket) <= 8)),
    CONSTRAINT telemetria_eventos_platform_check CHECK ((platform = ANY (ARRAY['android'::text, 'ios'::text, 'web'::text]))),
    CONSTRAINT telemetria_eventos_previous_last_state_check CHECK ((char_length(previous_last_state) <= 16)),
    CONSTRAINT telemetria_eventos_run_id_check CHECK ((char_length(run_id) <= 64)),
    CONSTRAINT telemetria_eventos_screen_check CHECK ((char_length(screen) <= 32)),
    CONSTRAINT telemetria_eventos_sync_stage_check CHECK ((char_length(sync_stage) <= 32))
);


--
-- Name: activador_equipo_historial activador_equipo_historial_activador_id_tstzrange_excl; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activador_equipo_historial
    ADD CONSTRAINT activador_equipo_historial_activador_id_tstzrange_excl EXCLUDE USING gist (activador_id WITH =, tstzrange(inicio, fin, '[)'::text) WITH &&);


--
-- Name: activador_equipo_historial activador_equipo_historial_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activador_equipo_historial
    ADD CONSTRAINT activador_equipo_historial_pkey PRIMARY KEY (id);


--
-- Name: activador_plaza_temporal activador_plaza_temporal_activador_id_tstzrange_excl; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activador_plaza_temporal
    ADD CONSTRAINT activador_plaza_temporal_activador_id_tstzrange_excl EXCLUDE USING gist (activador_id WITH =, tstzrange(inicio, fin, '[)'::text) WITH &&) WHERE ((cancelado_at IS NULL));


--
-- Name: activador_plaza_temporal activador_plaza_temporal_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activador_plaza_temporal
    ADD CONSTRAINT activador_plaza_temporal_pkey PRIMARY KEY (id);


--
-- Name: activador_roles activador_roles_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activador_roles
    ADD CONSTRAINT activador_roles_pkey PRIMARY KEY (usuario_id, rol);


--
-- Name: activadores activadores_auth_user_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activadores
    ADD CONSTRAINT activadores_auth_user_id_key UNIQUE (auth_user_id);


--
-- Name: activadores activadores_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activadores
    ADD CONSTRAINT activadores_pkey PRIMARY KEY (usuario_id);


--
-- Name: equipo_lider_historial equipo_lider_historial_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipo_lider_historial
    ADD CONSTRAINT equipo_lider_historial_pkey PRIMARY KEY (id);


--
-- Name: equipo_lider_historial equipo_lider_unico_periodo; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipo_lider_historial
    ADD CONSTRAINT equipo_lider_unico_periodo EXCLUDE USING gist (equipo_id WITH =, tstzrange(inicio, fin, '[)'::text) WITH &&);


--
-- Name: equipos equipos_id_plaza_id_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipos
    ADD CONSTRAINT equipos_id_plaza_id_key UNIQUE (id, plaza_id);


--
-- Name: equipos equipos_numero_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipos
    ADD CONSTRAINT equipos_numero_key UNIQUE (numero);


--
-- Name: equipos equipos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipos
    ADD CONSTRAINT equipos_pkey PRIMARY KEY (id);


--
-- Name: facturadores facturadores_codigo_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.facturadores
    ADD CONSTRAINT facturadores_codigo_key UNIQUE (codigo);


--
-- Name: facturadores facturadores_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.facturadores
    ADD CONSTRAINT facturadores_pkey PRIMARY KEY (id);


--
-- Name: activaciones formularios_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activaciones
    ADD CONSTRAINT formularios_pkey PRIMARY KEY (id);


--
-- Name: equipo_lider_historial lider_plaza_unico_periodo; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipo_lider_historial
    ADD CONSTRAINT lider_plaza_unico_periodo EXCLUDE USING gist (lider_id WITH =, plaza_id WITH =, tstzrange(inicio, fin, '[)'::text) WITH &&);


--
-- Name: notificaciones_destinatarios notificaciones_destinatarios_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notificaciones_destinatarios
    ADD CONSTRAINT notificaciones_destinatarios_pkey PRIMARY KEY (notificacion_id, usuario_id);


--
-- Name: notificaciones notificaciones_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notificaciones
    ADD CONSTRAINT notificaciones_pkey PRIMARY KEY (id);


--
-- Name: plazas plazas_nombre_normalizado_key; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plazas
    ADD CONSTRAINT plazas_nombre_normalizado_key UNIQUE (nombre_normalizado);


--
-- Name: plazas plazas_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.plazas
    ADD CONSTRAINT plazas_pkey PRIMARY KEY (id);


--
-- Name: telemetria_eventos telemetria_eventos_pkey; Type: CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.telemetria_eventos
    ADD CONSTRAINT telemetria_eventos_pkey PRIMARY KEY (id);


--
-- Name: idx_activaciones_equipo_fecha; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_activaciones_equipo_fecha ON public.activaciones USING btree (equipo_id_registro, fecha_activacion);


--
-- Name: idx_activaciones_facturador_fecha; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_activaciones_facturador_fecha ON public.activaciones USING btree (facturador_id_registro, fecha_activacion);


--
-- Name: idx_activaciones_lider_fecha; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_activaciones_lider_fecha ON public.activaciones USING btree (lider_id_registro, fecha_activacion);


--
-- Name: idx_activaciones_plaza_fecha; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_activaciones_plaza_fecha ON public.activaciones USING btree (plaza_id_registro, fecha_activacion);


--
-- Name: idx_activaciones_usuario_fecha; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_activaciones_usuario_fecha ON public.activaciones USING btree (usuario_id, fecha_activacion DESC);


--
-- Name: idx_activador_equipo_control_vigencia; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_activador_equipo_control_vigencia ON public.activador_equipo_historial USING btree (equipo_id, activador_id, inicio, fin);


--
-- Name: idx_activador_plaza_temporal_activa_vigente; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_activador_plaza_temporal_activa_vigente ON public.activador_plaza_temporal USING btree (activador_id, activo, inicio, fin) WHERE (cancelado_at IS NULL);


--
-- Name: idx_equipo_lider_control_vigencia; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_equipo_lider_control_vigencia ON public.equipo_lider_historial USING btree (lider_id, equipo_id, inicio, fin);


--
-- Name: idx_notificaciones_created_at; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notificaciones_created_at ON public.notificaciones USING btree (created_at DESC);


--
-- Name: idx_notificaciones_destinatarios_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX idx_notificaciones_destinatarios_id ON public.notificaciones_destinatarios USING btree (id);


--
-- Name: idx_notificaciones_destinatarios_notificacion; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notificaciones_destinatarios_notificacion ON public.notificaciones_destinatarios USING btree (notificacion_id);


--
-- Name: idx_notificaciones_destinatarios_usuario; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_notificaciones_destinatarios_usuario ON public.notificaciones_destinatarios USING btree (usuario_id);


--
-- Name: idx_plaza_temporal_vigencia; Type: INDEX; Schema: public; Owner: -
--

CREATE INDEX idx_plaza_temporal_vigencia ON public.activador_plaza_temporal USING btree (activador_id, inicio, fin) WHERE (cancelado_at IS NULL);


--
-- Name: ux_equipos_fallback_facturador_plaza; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_equipos_fallback_facturador_plaza ON public.equipos USING btree (plaza_id) WHERE ((nombre = 'Equipo sin asignar'::text) AND (facturador_id IS NULL));


--
-- Name: ux_equipos_lider_plaza_activo; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_equipos_lider_plaza_activo ON public.equipos USING btree (lider_actual_id, plaza_id) WHERE (activo AND (lider_actual_id IS NOT NULL));


--
-- Name: ux_facturadores_usuario_id; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_facturadores_usuario_id ON public.facturadores USING btree (usuario_id) WHERE (usuario_id IS NOT NULL);


--
-- Name: ux_telemetria_usuario_evento; Type: INDEX; Schema: public; Owner: -
--

CREATE UNIQUE INDEX ux_telemetria_usuario_evento ON public.telemetria_eventos USING btree (usuario_id, event_id);


--
-- Name: plazas trg_normalizar_nombre_plaza; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_normalizar_nombre_plaza BEFORE INSERT OR UPDATE OF nombre ON public.plazas FOR EACH ROW EXECUTE FUNCTION public.normalizar_nombre_plaza();


--
-- Name: activadores trg_registrar_cambio_equipo_activador; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_registrar_cambio_equipo_activador AFTER INSERT OR UPDATE ON public.activadores FOR EACH ROW EXECUTE FUNCTION public.registrar_cambio_equipo_activador();


--
-- Name: activaciones trg_snapshot_organizacion_activacion; Type: TRIGGER; Schema: public; Owner: -
--

CREATE TRIGGER trg_snapshot_organizacion_activacion BEFORE INSERT ON public.activaciones FOR EACH ROW EXECUTE FUNCTION public.snapshot_organizacion_activacion();


--
-- Name: activaciones activaciones_equipo_id_registro_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activaciones
    ADD CONSTRAINT activaciones_equipo_id_registro_fkey FOREIGN KEY (equipo_id_registro) REFERENCES public.equipos(id);


--
-- Name: activaciones activaciones_facturador_id_registro_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activaciones
    ADD CONSTRAINT activaciones_facturador_id_registro_fkey FOREIGN KEY (facturador_id_registro) REFERENCES public.facturadores(id);


--
-- Name: activaciones activaciones_lider_id_registro_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activaciones
    ADD CONSTRAINT activaciones_lider_id_registro_fkey FOREIGN KEY (lider_id_registro) REFERENCES public.activadores(usuario_id);


--
-- Name: activaciones activaciones_plaza_base_id_registro_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activaciones
    ADD CONSTRAINT activaciones_plaza_base_id_registro_fkey FOREIGN KEY (plaza_base_id_registro) REFERENCES public.plazas(id);


--
-- Name: activaciones activaciones_plaza_efectiva_id_registro_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activaciones
    ADD CONSTRAINT activaciones_plaza_efectiva_id_registro_fkey FOREIGN KEY (plaza_efectiva_id_registro) REFERENCES public.plazas(id);


--
-- Name: activaciones activaciones_plaza_id_registro_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activaciones
    ADD CONSTRAINT activaciones_plaza_id_registro_fkey FOREIGN KEY (plaza_id_registro) REFERENCES public.plazas(id);


--
-- Name: activaciones activaciones_plaza_temporal_asignacion_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activaciones
    ADD CONSTRAINT activaciones_plaza_temporal_asignacion_id_fkey FOREIGN KEY (plaza_temporal_asignacion_id) REFERENCES public.activador_plaza_temporal(id);


--
-- Name: activador_equipo_historial activador_equipo_historial_activador_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activador_equipo_historial
    ADD CONSTRAINT activador_equipo_historial_activador_id_fkey FOREIGN KEY (activador_id) REFERENCES public.activadores(usuario_id) ON DELETE RESTRICT;


--
-- Name: activador_equipo_historial activador_equipo_historial_autorizado_por_perfil_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activador_equipo_historial
    ADD CONSTRAINT activador_equipo_historial_autorizado_por_perfil_fkey FOREIGN KEY (autorizado_por) REFERENCES public.activadores(usuario_id);


--
-- Name: activador_equipo_historial activador_equipo_historial_equipo_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activador_equipo_historial
    ADD CONSTRAINT activador_equipo_historial_equipo_id_fkey FOREIGN KEY (equipo_id) REFERENCES public.equipos(id) ON DELETE RESTRICT;


--
-- Name: activador_plaza_temporal activador_plaza_temporal_activador_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activador_plaza_temporal
    ADD CONSTRAINT activador_plaza_temporal_activador_id_fkey FOREIGN KEY (activador_id) REFERENCES public.activadores(usuario_id) ON DELETE RESTRICT;


--
-- Name: activador_plaza_temporal activador_plaza_temporal_autorizado_por_perfil_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activador_plaza_temporal
    ADD CONSTRAINT activador_plaza_temporal_autorizado_por_perfil_fkey FOREIGN KEY (autorizado_por) REFERENCES public.activadores(usuario_id);


--
-- Name: activador_plaza_temporal activador_plaza_temporal_cancelado_por_perfil_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activador_plaza_temporal
    ADD CONSTRAINT activador_plaza_temporal_cancelado_por_perfil_fkey FOREIGN KEY (cancelado_por) REFERENCES public.activadores(usuario_id);


--
-- Name: activador_plaza_temporal activador_plaza_temporal_plaza_temporal_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activador_plaza_temporal
    ADD CONSTRAINT activador_plaza_temporal_plaza_temporal_id_fkey FOREIGN KEY (plaza_temporal_id) REFERENCES public.plazas(id) ON DELETE RESTRICT;


--
-- Name: activador_roles activador_roles_usuario_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activador_roles
    ADD CONSTRAINT activador_roles_usuario_id_fkey FOREIGN KEY (usuario_id) REFERENCES public.activadores(usuario_id) ON DELETE CASCADE;


--
-- Name: activadores activadores_auth_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activadores
    ADD CONSTRAINT activadores_auth_user_id_fkey FOREIGN KEY (auth_user_id) REFERENCES auth.users(id) ON DELETE SET NULL;


--
-- Name: activadores activadores_equipo_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activadores
    ADD CONSTRAINT activadores_equipo_id_fkey FOREIGN KEY (equipo_id) REFERENCES public.equipos(id);


--
-- Name: activadores activadores_plaza_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.activadores
    ADD CONSTRAINT activadores_plaza_id_fkey FOREIGN KEY (plaza_id) REFERENCES public.plazas(id);


--
-- Name: equipo_lider_historial equipo_lider_historial_autorizado_por_perfil_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipo_lider_historial
    ADD CONSTRAINT equipo_lider_historial_autorizado_por_perfil_fkey FOREIGN KEY (autorizado_por) REFERENCES public.activadores(usuario_id);


--
-- Name: equipo_lider_historial equipo_lider_historial_equipo_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipo_lider_historial
    ADD CONSTRAINT equipo_lider_historial_equipo_id_fkey FOREIGN KEY (equipo_id) REFERENCES public.equipos(id);


--
-- Name: equipo_lider_historial equipo_lider_historial_lider_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipo_lider_historial
    ADD CONSTRAINT equipo_lider_historial_lider_id_fkey FOREIGN KEY (lider_id) REFERENCES public.activadores(usuario_id) ON DELETE RESTRICT;


--
-- Name: equipo_lider_historial equipo_lider_historial_plaza_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipo_lider_historial
    ADD CONSTRAINT equipo_lider_historial_plaza_id_fkey FOREIGN KEY (plaza_id) REFERENCES public.plazas(id) ON DELETE RESTRICT;


--
-- Name: equipos equipos_facturador_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipos
    ADD CONSTRAINT equipos_facturador_id_fkey FOREIGN KEY (facturador_id) REFERENCES public.facturadores(id);


--
-- Name: equipos equipos_lider_actual_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipos
    ADD CONSTRAINT equipos_lider_actual_id_fkey FOREIGN KEY (lider_actual_id) REFERENCES public.activadores(usuario_id);


--
-- Name: equipos equipos_plaza_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.equipos
    ADD CONSTRAINT equipos_plaza_id_fkey FOREIGN KEY (plaza_id) REFERENCES public.plazas(id);


--
-- Name: facturadores facturadores_usuario_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.facturadores
    ADD CONSTRAINT facturadores_usuario_id_fkey FOREIGN KEY (usuario_id) REFERENCES public.activadores(usuario_id) ON DELETE SET NULL;


--
-- Name: notificaciones_destinatarios notificaciones_destinatarios_notificacion_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: -
--

ALTER TABLE ONLY public.notificaciones_destinatarios
    ADD CONSTRAINT notificaciones_destinatarios_notificacion_id_fkey FOREIGN KEY (notificacion_id) REFERENCES public.notificaciones(id) ON DELETE CASCADE;


--
-- Name: activaciones; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.activaciones ENABLE ROW LEVEL SECURITY;

--
-- Name: activaciones activaciones_insert_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY activaciones_insert_own ON public.activaciones FOR INSERT TO authenticated WITH CHECK ((usuario_id = auth.uid()));


--
-- Name: activaciones activaciones_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY activaciones_select_own ON public.activaciones FOR SELECT TO authenticated USING ((usuario_id = auth.uid()));


--
-- Name: activaciones activaciones_update_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY activaciones_update_own ON public.activaciones FOR UPDATE TO authenticated USING ((usuario_id = auth.uid())) WITH CHECK ((usuario_id = auth.uid()));


--
-- Name: activador_equipo_historial; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.activador_equipo_historial ENABLE ROW LEVEL SECURITY;

--
-- Name: activador_plaza_temporal; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.activador_plaza_temporal ENABLE ROW LEVEL SECURITY;

--
-- Name: activador_plaza_temporal activador_plaza_temporal_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY activador_plaza_temporal_select_own ON public.activador_plaza_temporal FOR SELECT TO authenticated USING (((auth.uid() = activador_id) AND (activo = true) AND (cancelado_at IS NULL)));


--
-- Name: activador_roles; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.activador_roles ENABLE ROW LEVEL SECURITY;

--
-- Name: activador_roles activador_roles_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY activador_roles_select_own ON public.activador_roles FOR SELECT TO authenticated USING ((usuario_id = ( SELECT auth.uid() AS uid)));


--
-- Name: activadores; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.activadores ENABLE ROW LEVEL SECURITY;

--
-- Name: activadores activadores_select_own_profile; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY activadores_select_own_profile ON public.activadores FOR SELECT TO authenticated USING ((usuario_id = auth.uid()));


--
-- Name: equipo_lider_historial; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.equipo_lider_historial ENABLE ROW LEVEL SECURITY;

--
-- Name: equipos; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.equipos ENABLE ROW LEVEL SECURITY;

--
-- Name: facturadores; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.facturadores ENABLE ROW LEVEL SECURITY;

--
-- Name: notificaciones_destinatarios notif_dest_select_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY notif_dest_select_own ON public.notificaciones_destinatarios FOR SELECT TO authenticated USING ((usuario_id = auth.uid()));


--
-- Name: notificaciones_destinatarios notif_dest_update_own; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY notif_dest_update_own ON public.notificaciones_destinatarios FOR UPDATE TO authenticated USING ((usuario_id = auth.uid())) WITH CHECK ((usuario_id = auth.uid()));


--
-- Name: notificaciones notif_select_linked; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY notif_select_linked ON public.notificaciones FOR SELECT TO authenticated USING ((EXISTS ( SELECT 1
   FROM public.notificaciones_destinatarios nd
  WHERE ((nd.notificacion_id = notificaciones.id) AND (nd.usuario_id = auth.uid())))));


--
-- Name: notificaciones; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.notificaciones ENABLE ROW LEVEL SECURITY;

--
-- Name: notificaciones_destinatarios; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.notificaciones_destinatarios ENABLE ROW LEVEL SECURITY;

--
-- Name: plazas; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.plazas ENABLE ROW LEVEL SECURITY;

--
-- Name: telemetria_eventos telemetria insert propio; Type: POLICY; Schema: public; Owner: -
--

CREATE POLICY "telemetria insert propio" ON public.telemetria_eventos FOR INSERT TO authenticated WITH CHECK ((usuario_id = auth.uid()));


--
-- Name: telemetria_eventos; Type: ROW SECURITY; Schema: public; Owner: -
--

ALTER TABLE public.telemetria_eventos ENABLE ROW LEVEL SECURITY;

--
-- Name: SCHEMA public; Type: ACL; Schema: -; Owner: -
--

GRANT USAGE ON SCHEMA public TO postgres;
GRANT USAGE ON SCHEMA public TO anon;
GRANT USAGE ON SCHEMA public TO authenticated;
GRANT USAGE ON SCHEMA public TO service_role;


--
-- Name: FUNCTION actualizar_equipo_organizacion(p_equipo_id uuid, p_numero bigint, p_nombre text, p_plaza_id uuid, p_facturador_id uuid, p_lider_id uuid, p_activo boolean, p_inicio timestamp with time zone, p_motivo text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.actualizar_equipo_organizacion(p_equipo_id uuid, p_numero bigint, p_nombre text, p_plaza_id uuid, p_facturador_id uuid, p_lider_id uuid, p_activo boolean, p_inicio timestamp with time zone, p_motivo text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.actualizar_equipo_organizacion(p_equipo_id uuid, p_numero bigint, p_nombre text, p_plaza_id uuid, p_facturador_id uuid, p_lider_id uuid, p_activo boolean, p_inicio timestamp with time zone, p_motivo text) TO service_role;


--
-- Name: FUNCTION asignar_activador_equipo(p_activador_id uuid, p_equipo_id uuid, p_inicio timestamp with time zone, p_motivo text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.asignar_activador_equipo(p_activador_id uuid, p_equipo_id uuid, p_inicio timestamp with time zone, p_motivo text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.asignar_activador_equipo(p_activador_id uuid, p_equipo_id uuid, p_inicio timestamp with time zone, p_motivo text) TO service_role;


--
-- Name: FUNCTION asignar_equipos_lider(p_lider_id uuid, p_equipo_ids uuid[], p_inicio timestamp with time zone, p_motivo text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.asignar_equipos_lider(p_lider_id uuid, p_equipo_ids uuid[], p_inicio timestamp with time zone, p_motivo text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.asignar_equipos_lider(p_lider_id uuid, p_equipo_ids uuid[], p_inicio timestamp with time zone, p_motivo text) TO service_role;


--
-- Name: FUNCTION asignar_lider_equipo(p_equipo_id uuid, p_lider_id uuid, p_inicio timestamp with time zone, p_motivo text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.asignar_lider_equipo(p_equipo_id uuid, p_lider_id uuid, p_inicio timestamp with time zone, p_motivo text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.asignar_lider_equipo(p_equipo_id uuid, p_lider_id uuid, p_inicio timestamp with time zone, p_motivo text) TO service_role;


--
-- Name: FUNCTION control_activaciones_detalle(p_activador_id uuid, p_equipo_id uuid, p_desde date, p_hasta date); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.control_activaciones_detalle(p_activador_id uuid, p_equipo_id uuid, p_desde date, p_hasta date) FROM PUBLIC;
GRANT ALL ON FUNCTION public.control_activaciones_detalle(p_activador_id uuid, p_equipo_id uuid, p_desde date, p_hasta date) TO authenticated;
GRANT ALL ON FUNCTION public.control_activaciones_detalle(p_activador_id uuid, p_equipo_id uuid, p_desde date, p_hasta date) TO service_role;


--
-- Name: FUNCTION control_activadores_jerarquia(p_desde date, p_hasta date); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.control_activadores_jerarquia(p_desde date, p_hasta date) FROM PUBLIC;
GRANT ALL ON FUNCTION public.control_activadores_jerarquia(p_desde date, p_hasta date) TO authenticated;
GRANT ALL ON FUNCTION public.control_activadores_jerarquia(p_desde date, p_hasta date) TO service_role;


--
-- Name: FUNCTION normalizar_nombre_plaza(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.normalizar_nombre_plaza() TO anon;
GRANT ALL ON FUNCTION public.normalizar_nombre_plaza() TO authenticated;
GRANT ALL ON FUNCTION public.normalizar_nombre_plaza() TO service_role;


--
-- Name: FUNCTION plaza_efectiva_activador(p_activador_id uuid, p_momento timestamp with time zone); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.plaza_efectiva_activador(p_activador_id uuid, p_momento timestamp with time zone) FROM PUBLIC;
GRANT ALL ON FUNCTION public.plaza_efectiva_activador(p_activador_id uuid, p_momento timestamp with time zone) TO authenticated;
GRANT ALL ON FUNCTION public.plaza_efectiva_activador(p_activador_id uuid, p_momento timestamp with time zone) TO service_role;


--
-- Name: FUNCTION puede_leer_foto_activacion_equipo(p_nombre text); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.puede_leer_foto_activacion_equipo(p_nombre text) FROM PUBLIC;
GRANT ALL ON FUNCTION public.puede_leer_foto_activacion_equipo(p_nombre text) TO authenticated;
GRANT ALL ON FUNCTION public.puede_leer_foto_activacion_equipo(p_nombre text) TO service_role;


--
-- Name: FUNCTION reasignar_y_eliminar_plaza(p_plaza_origen uuid, p_plaza_destino uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.reasignar_y_eliminar_plaza(p_plaza_origen uuid, p_plaza_destino uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.reasignar_y_eliminar_plaza(p_plaza_origen uuid, p_plaza_destino uuid) TO service_role;


--
-- Name: FUNCTION registrar_cambio_equipo_activador(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.registrar_cambio_equipo_activador() TO anon;
GRANT ALL ON FUNCTION public.registrar_cambio_equipo_activador() TO authenticated;
GRANT ALL ON FUNCTION public.registrar_cambio_equipo_activador() TO service_role;


--
-- Name: FUNCTION registrar_eventos_telemetria(p_eventos jsonb); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.registrar_eventos_telemetria(p_eventos jsonb) FROM PUBLIC;
GRANT ALL ON FUNCTION public.registrar_eventos_telemetria(p_eventos jsonb) TO authenticated;
GRANT ALL ON FUNCTION public.registrar_eventos_telemetria(p_eventos jsonb) TO service_role;


--
-- Name: FUNCTION snapshot_organizacion_activacion(); Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON FUNCTION public.snapshot_organizacion_activacion() TO anon;
GRANT ALL ON FUNCTION public.snapshot_organizacion_activacion() TO authenticated;
GRANT ALL ON FUNCTION public.snapshot_organizacion_activacion() TO service_role;


--
-- Name: FUNCTION validar_elegibilidad_reactivacion(p_ci text, p_telefono text, p_tipo_activacion text, p_fecha_referencia date, p_registro_id uuid); Type: ACL; Schema: public; Owner: -
--

REVOKE ALL ON FUNCTION public.validar_elegibilidad_reactivacion(p_ci text, p_telefono text, p_tipo_activacion text, p_fecha_referencia date, p_registro_id uuid) FROM PUBLIC;
GRANT ALL ON FUNCTION public.validar_elegibilidad_reactivacion(p_ci text, p_telefono text, p_tipo_activacion text, p_fecha_referencia date, p_registro_id uuid) TO authenticated;
GRANT ALL ON FUNCTION public.validar_elegibilidad_reactivacion(p_ci text, p_telefono text, p_tipo_activacion text, p_fecha_referencia date, p_registro_id uuid) TO service_role;


--
-- Name: TABLE activaciones; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE ON TABLE public.activaciones TO anon;
GRANT SELECT,INSERT,REFERENCES,TRIGGER,TRUNCATE,UPDATE ON TABLE public.activaciones TO authenticated;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.activaciones TO service_role;


--
-- Name: TABLE activador_equipo_historial; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.activador_equipo_historial TO anon;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.activador_equipo_historial TO authenticated;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.activador_equipo_historial TO service_role;


--
-- Name: TABLE activador_plaza_temporal; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.activador_plaza_temporal TO anon;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.activador_plaza_temporal TO authenticated;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.activador_plaza_temporal TO service_role;


--
-- Name: TABLE activador_roles; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.activador_roles TO service_role;


--
-- Name: COLUMN activador_roles.usuario_id; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(usuario_id) ON TABLE public.activador_roles TO authenticated;


--
-- Name: COLUMN activador_roles.rol; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT(rol) ON TABLE public.activador_roles TO authenticated;


--
-- Name: TABLE activadores; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE ON TABLE public.activadores TO anon;
GRANT SELECT,REFERENCES,TRIGGER,TRUNCATE ON TABLE public.activadores TO authenticated;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.activadores TO service_role;


--
-- Name: TABLE equipo_lider_historial; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.equipo_lider_historial TO anon;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.equipo_lider_historial TO authenticated;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.equipo_lider_historial TO service_role;


--
-- Name: TABLE equipos; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.equipos TO anon;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.equipos TO authenticated;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.equipos TO service_role;


--
-- Name: SEQUENCE equipos_numero_seq; Type: ACL; Schema: public; Owner: -
--

GRANT ALL ON SEQUENCE public.equipos_numero_seq TO anon;
GRANT ALL ON SEQUENCE public.equipos_numero_seq TO authenticated;
GRANT ALL ON SEQUENCE public.equipos_numero_seq TO service_role;


--
-- Name: TABLE facturadores; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.facturadores TO anon;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.facturadores TO authenticated;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.facturadores TO service_role;


--
-- Name: TABLE notificaciones; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.notificaciones TO anon;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.notificaciones TO authenticated;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.notificaciones TO service_role;


--
-- Name: TABLE notificaciones_destinatarios; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.notificaciones_destinatarios TO anon;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.notificaciones_destinatarios TO authenticated;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.notificaciones_destinatarios TO service_role;


--
-- Name: TABLE plazas; Type: ACL; Schema: public; Owner: -
--

GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.plazas TO anon;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.plazas TO authenticated;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.plazas TO service_role;


--
-- Name: TABLE telemetria_eventos; Type: ACL; Schema: public; Owner: -
--

GRANT INSERT,REFERENCES,TRIGGER,TRUNCATE ON TABLE public.telemetria_eventos TO anon;
GRANT INSERT,REFERENCES,TRIGGER,TRUNCATE ON TABLE public.telemetria_eventos TO authenticated;
GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLE public.telemetria_eventos TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON SEQUENCES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR SEQUENCES; Type: DEFAULT ACL; Schema: public; Owner: -
--



--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT ALL ON FUNCTIONS TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR FUNCTIONS; Type: DEFAULT ACL; Schema: public; Owner: -
--



--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--

ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLES TO postgres;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLES TO anon;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLES TO authenticated;
ALTER DEFAULT PRIVILEGES FOR ROLE postgres IN SCHEMA public GRANT SELECT,INSERT,REFERENCES,DELETE,TRIGGER,TRUNCATE,UPDATE ON TABLES TO service_role;


--
-- Name: DEFAULT PRIVILEGES FOR TABLES; Type: DEFAULT ACL; Schema: public; Owner: -
--



--
-- PostgreSQL database dump complete
--



set search_path = public, extensions;

insert into storage.buckets (id, name, public) values ('fotos-activaciones', 'fotos-activaciones', false)
on conflict (id) do update set public = false;

create policy storage_fotos_activaciones_insert_own on storage.objects for insert to authenticated
  with check (((bucket_id = 'fotos-activaciones'::text) AND (name ~~ (('activaciones/'::text || (auth.uid())::text) || '/%'::text))));
create policy storage_fotos_activaciones_select_equipo on storage.objects for select to authenticated
  using (((bucket_id = 'fotos-activaciones'::text) AND ((name ~~ (('activaciones/'::text || (auth.uid())::text) || '/%'::text)) OR puede_leer_foto_activacion_equipo(name))));
create policy storage_fotos_activaciones_select_own on storage.objects for select to authenticated
  using (((bucket_id = 'fotos-activaciones'::text) AND (name ~~ (('activaciones/'::text || (auth.uid())::text) || '/%'::text))));
create policy storage_fotos_activaciones_update_own on storage.objects for update to authenticated
  using (((bucket_id = 'fotos-activaciones'::text) AND (name ~~ (('activaciones/'::text || (auth.uid())::text) || '/%'::text))))
  with check (((bucket_id = 'fotos-activaciones'::text) AND (name ~~ (('activaciones/'::text || (auth.uid())::text) || '/%'::text))));
