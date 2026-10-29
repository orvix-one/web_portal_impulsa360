-- IMPULSA360 / STAGING
-- Consultas de diagnostico. Este archivo no ejecuta la migracion.
-- Ejecutar cada bloque por separado en Supabase SQL Editor.

-- Requisito para reproducir exactamente lower(unaccent(btrim(nombre))).
select extname, extversion
from pg_extension
where extname in ('unaccent', 'btree_gist', 'pgcrypto')
order by extname;

-- Si unaccent no aparece, habilitarla antes de las consultas de normalizacion.
-- Esta es la misma operacion aditiva incluida al inicio de la migracion:
-- create extension if not exists unaccent;

-- ============================================================================
-- PREFLIGHT 1: activadores sin plaza resoluble. Resultado informativo:
-- estas filas quedaran con organizacion_pendiente = true, sin plaza_id/equipo_id.
-- Antes de la migracion, plaza es la fuente compatible disponible.
-- ============================================================================
select usuario_id, nombre, email, rol, estado, plaza
from public.activadores
where rol = 'activador'
  and nullif(btrim(plaza), '') is null
order by nombre nulls last, usuario_id;

-- Conteo resumido del mismo problema.
select count(*) as activadores_sin_plaza_resoluble
from public.activadores
where rol = 'activador'
  and nullif(btrim(plaza), '') is null;

-- ============================================================================
-- PREFLIGHT 2: combinaciones lider/plaza que producirian un mismo equipo.
-- Varias filas de activadores por combinacion son validas; esta consulta permite
-- revisar la agrupacion y las variantes textuales que se consolidaran.
-- ============================================================================
select
  a.lider_id,
  l.nombre as lider_nombre,
  lower(unaccent(btrim(a.plaza))) as plaza_normalizada,
  count(*) as activadores,
  count(distinct btrim(a.plaza)) as variantes_textuales,
  array_agg(distinct btrim(a.plaza) order by btrim(a.plaza)) as plazas_origen
from public.activadores a
left join public.activadores l on l.usuario_id = a.lider_id
where a.rol = 'activador'
  and a.lider_id is not null
  and nullif(btrim(a.plaza), '') is not null
group by a.lider_id, l.nombre, lower(unaccent(btrim(a.plaza)))
having count(*) > 1 or count(distinct btrim(a.plaza)) > 1
order by l.nombre nulls last, plaza_normalizada;

-- Lideres referenciados por activadores que no existen como lider activo.
-- Resultado informativo: estos casos quedaran pendientes, sin equipo automatico.
select
  a.usuario_id as activador_id,
  a.nombre as activador,
  a.lider_id,
  l.nombre as lider_encontrado,
  l.rol as lider_rol,
  l.estado as lider_estado,
  a.plaza
from public.activadores a
left join public.activadores l on l.usuario_id = a.lider_id
where a.rol = 'activador'
  and a.lider_id is not null
  and (l.usuario_id is null or l.rol <> 'lider' or l.estado <> 'activo')
order by a.nombre nulls last;

-- ============================================================================
-- PREFLIGHT 3: equipos activos duplicados por lider/plaza.
-- Ejecutar si public.equipos y public.plazas ya existen en staging.
-- Resultado esperado: 0 filas.
-- ============================================================================
select
  e.lider_actual_id,
  l.nombre as lider,
  e.plaza_id,
  p.nombre as plaza,
  count(*) as equipos_activos,
  array_agg(e.numero order by e.numero) as numeros_equipo
from public.equipos e
join public.plazas p on p.id = e.plaza_id
left join public.activadores l on l.usuario_id = e.lider_actual_id
where e.activo and e.lider_actual_id is not null
group by e.lider_actual_id, l.nombre, e.plaza_id, p.nombre
having count(*) > 1
order by l.nombre nulls last, p.nombre;

-- Confirmar primero si las tablas del bloque anterior existen.
select
  to_regclass('public.equipos') as equipos,
  to_regclass('public.plazas') as plazas;

-- ============================================================================
-- PREFLIGHT 4: activadores que quedaran pendientes durante el backfill.
-- La migracion crea equipo por lider/plaza cuando el lider existe con rol lider,
-- o un equipo "sin asignar" por plaza cuando lider_id es null.
-- El resultado se conserva para seguimiento y ya no aborta la migracion.
-- ============================================================================
select
  a.usuario_id,
  a.nombre,
  a.lider_id,
  a.plaza,
  case
    when nullif(btrim(a.plaza), '') is null then 'SIN_PLAZA'
    when a.lider_id is not null and l.usuario_id is null then 'LIDER_INEXISTENTE'
    when a.lider_id is not null and l.rol <> 'lider' then 'REFERENCIA_NO_ES_LIDER'
    else 'REVISAR'
  end as causa
from public.activadores a
left join public.activadores l on l.usuario_id = a.lider_id
where a.rol = 'activador'
  and (
    nullif(btrim(a.plaza), '') is null
    or (a.lider_id is not null and (l.usuario_id is null or l.rol <> 'lider'))
  )
order by causa, a.nombre nulls last;

-- ============================================================================
-- PREFLIGHT 5: valores de plaza consolidados por normalizacion.
-- Muestra solo grupos con mas de una escritura original.
-- ============================================================================
with plazas_origen as (
  select 'activadores.plaza'::text as fuente, btrim(plaza) as nombre
  from public.activadores
  where nullif(btrim(plaza), '') is not null
  union all
  select 'activaciones.ciudad_activacion', btrim(ciudad_activacion)
  from public.activaciones
  where nullif(btrim(ciudad_activacion), '') is not null
), normalizadas as (
  select fuente, nombre, lower(unaccent(btrim(nombre))) as nombre_normalizado
  from plazas_origen
)
select
  nombre_normalizado,
  count(*) as apariciones,
  count(distinct nombre) as variantes,
  array_agg(distinct nombre order by nombre) as nombres_origen,
  array_agg(distinct fuente order by fuente) as fuentes
from normalizadas
group by nombre_normalizado
having count(distinct nombre) > 1
order by variantes desc, nombre_normalizado;

-- ============================================================================
-- PREFLIGHT 6: conteos base para comparar despues de la migracion.
-- Guardar el resultado fuera del SQL Editor.
-- ============================================================================
select
  (select count(*) from public.activadores) as usuarios_totales,
  (select count(*) from public.activadores where rol = 'activador') as activadores,
  (select count(*) from public.activadores where rol = 'lider') as lideres,
  (select count(*) from public.activaciones) as activaciones;

-- ============================================================================
-- POSTFLIGHT 1: todos los equipos tienen plaza. Resultado esperado: 0 filas.
-- ============================================================================
select e.id, e.numero, e.nombre, e.lider_actual_id
from public.equipos e
where e.plaza_id is null;

-- ============================================================================
-- POSTFLIGHT 2: todo activador NO pendiente tiene equipo y periodo vigente.
-- Los pendientes se revisan en la consulta de seguimiento. Esperado: 0 filas.
-- ============================================================================
select
  a.usuario_id,
  a.nombre,
  a.equipo_id,
  e.numero as equipo_numero,
  count(h.id) filter (where h.fin is null) as periodos_vigentes
from public.activadores a
left join public.equipos e on e.id = a.equipo_id
left join public.activador_equipo_historial h
  on h.activador_id = a.usuario_id and h.fin is null
where a.rol = 'activador'
  and not a.organizacion_pendiente
group by a.usuario_id, a.nombre, a.equipo_id, e.numero
having a.equipo_id is null or e.id is null
   or count(h.id) filter (where h.fin is null) <> 1
order by a.nombre nulls last;

-- La plaza permanente del activador debe coincidir con la plaza de su equipo.
-- Resultado esperado: 0 filas.
select
  a.usuario_id,
  a.nombre,
  a.plaza_base,
  e.numero as equipo_numero,
  p.nombre as plaza_equipo
from public.activadores a
join public.equipos e on e.id = a.equipo_id
join public.plazas p on p.id = e.plaza_id
where a.rol = 'activador'
  and lower(unaccent(btrim(coalesce(a.plaza_base, a.plaza)))) <> p.nombre_normalizado;

-- ============================================================================
-- POSTFLIGHT 3: solapamientos historicos por equipo. Esperado: 0 filas.
-- ============================================================================
select
  h1.equipo_id,
  h1.id as periodo_1,
  h2.id as periodo_2,
  h1.inicio as inicio_1,
  h1.fin as fin_1,
  h2.inicio as inicio_2,
  h2.fin as fin_2
from public.equipo_lider_historial h1
join public.equipo_lider_historial h2
  on h1.equipo_id = h2.equipo_id
 and h1.id < h2.id
 and tstzrange(h1.inicio, h1.fin, '[)') && tstzrange(h2.inicio, h2.fin, '[)')
order by h1.equipo_id, h1.inicio;

-- ============================================================================
-- POSTFLIGHT 4: solapamientos por lider/plaza. Esperado: 0 filas.
-- ============================================================================
select
  h1.lider_id,
  h1.plaza_id,
  h1.equipo_id as equipo_1,
  h2.equipo_id as equipo_2,
  h1.id as periodo_1,
  h2.id as periodo_2
from public.equipo_lider_historial h1
join public.equipo_lider_historial h2
  on h1.lider_id = h2.lider_id
 and h1.plaza_id = h2.plaza_id
 and h1.id < h2.id
 and tstzrange(h1.inicio, h1.fin, '[)') && tstzrange(h2.inicio, h2.fin, '[)')
order by h1.lider_id, h1.plaza_id, h1.inicio;

-- ============================================================================
-- POSTFLIGHT 5: snapshots incompletos. Activaciones de usuarios pendientes pueden
-- aparecer legitimamente; priorizar filas cuyo activador no este pendiente.
-- Se listan por separado para distinguir una organizacion faltante de textos
-- historicos que genuinamente no existian en el dato original.
-- ============================================================================
select
  ac.id,
  ac.usuario_id,
  ac.created_at,
  ac.equipo_id_registro,
  ac.facturador_id_registro,
  ac.lider_id_registro,
  ac.plaza_base_id_registro,
  ac.plaza_efectiva_id_registro,
  ac.plaza_id_registro
from public.activaciones ac
left join public.activadores au on au.usuario_id = ac.usuario_id
where ac.equipo_id_registro is null
   or ac.facturador_id_registro is null
   or ac.plaza_base_id_registro is null
   or ac.plaza_efectiva_id_registro is null
   or ac.plaza_id_registro is null
order by coalesce(au.organizacion_pendiente, false), ac.created_at, ac.id;

select
  count(*) as activaciones_totales,
  count(*) filter (where equipo_id_registro is not null) as con_equipo,
  count(*) filter (where facturador_id_registro is not null) as con_facturador,
  count(*) filter (where lider_id_registro is not null) as con_lider,
  count(*) filter (where plaza_base_id_registro is not null) as con_plaza_base,
  count(*) filter (where plaza_efectiva_id_registro is not null) as con_plaza_efectiva
from public.activaciones;

-- ============================================================================
-- POSTFLIGHT 6: la plaza temporal no reemplaza la plaza permanente del snapshot.
-- Para activaciones temporales, la base debe seguir siendo la plaza del equipo y
-- la efectiva debe ser la plaza de la asignacion temporal. Esperado: 0 filas.
-- ============================================================================
select
  ac.id as activacion_id,
  ac.equipo_id_registro,
  e.plaza_id as plaza_permanente_equipo,
  ac.plaza_base_id_registro,
  ac.plaza_efectiva_id_registro,
  pt.plaza_temporal_id,
  ac.plaza_temporal_registro
from public.activaciones ac
join public.equipos e on e.id = ac.equipo_id_registro
join public.activador_plaza_temporal pt on pt.id = ac.plaza_temporal_asignacion_id
where ac.plaza_temporal_registro
  and (
    ac.plaza_base_id_registro is distinct from e.plaza_id
    or ac.plaza_efectiva_id_registro is distinct from pt.plaza_temporal_id
  );

-- Guardar este resultado antes de crear la plaza temporal y repetirlo durante y
-- despues del periodo: equipo_id y plaza_permanente_equipo deben ser identicos.
select
  a.usuario_id,
  a.equipo_id,
  e.plaza_id as plaza_permanente_equipo,
  pe.plaza_efectiva_id,
  pe.es_temporal,
  pe.asignacion_id
from public.activadores a
join public.equipos e on e.id = a.equipo_id
left join lateral public.plaza_efectiva_activador(a.usuario_id, now()) pe on true
where a.rol = 'activador'
order by a.nombre;

-- Conteos posteriores: activadores y activaciones deben coincidir con preflight.
select
  (select count(*) from public.activadores where rol = 'activador') as activadores,
  (select count(*) from public.activaciones) as activaciones,
  (select count(*) from public.plazas) as plazas,
  (select count(*) from public.equipos) as equipos;

-- ============================================================================
-- SEGUIMIENTO: activadores pendientes de completar organizacion.
-- Ejecutar despues de la migracion hasta que el resultado quede vacio.
-- ============================================================================
select
  a.usuario_id,
  a.nombre,
  a.email,
  a.estado,
  a.plaza as plaza_legacy,
  a.plaza_base,
  a.plaza_id,
  a.equipo_id,
  case
    when a.plaza_id is null and a.equipo_id is null then 'SIN_PLAZA_Y_EQUIPO'
    when a.plaza_id is null then 'SIN_PLAZA'
    when a.equipo_id is null then 'SIN_EQUIPO'
    else 'REVISAR_MARCA'
  end as pendiente
from public.activadores a
where a.rol = 'activador'
  and (a.organizacion_pendiente or a.plaza_id is null or a.equipo_id is null)
order by a.nombre nulls last, a.usuario_id;
