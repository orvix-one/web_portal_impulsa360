-- Preflight READ-ONLY para la migracion 202609160004_desacoplar_auth_historico.
-- Solo SELECT: no modifica nada. Ejecutar antes de migrar y comparar con lo esperado.

-- 1. Totales de activadores e integridad de la identidad historica.
select
  count(*) as total_activadores,
  count(*) filter (where a.usuario_id is null) as usuario_id_nulos,
  count(distinct a.usuario_id) as usuario_id_distintos
from public.activadores a;
-- Esperado: usuario_id_nulos = 0, usuario_id_distintos = total_activadores.

-- 2. auth_user_id esperado tras el backfill.
select count(*) as auth_user_id_esperados
from public.activadores;
-- Esperado: igual a total_activadores (backfill 1:1).

-- 3. Perfiles historicos cuya identidad ya no tiene cuenta en auth.users.
select count(*) as perfiles_sin_auth
from public.activadores a
where not exists (select 1 from auth.users u where u.id = a.usuario_id);

-- 4. Huerfanos en auditoria vs activadores (deben ser 0 para migrar).
select count(*) as huerfanos_equipo_lider_autorizado
from public.equipo_lider_historial h
where h.autorizado_por is not null
  and not exists (select 1 from public.activadores a where a.usuario_id = h.autorizado_por);

select count(*) as huerfanos_activador_equipo_autorizado
from public.activador_equipo_historial h
where h.autorizado_por is not null
  and not exists (select 1 from public.activadores a where a.usuario_id = h.autorizado_por);

select count(*) as huerfanos_plaza_temporal_autorizado
from public.activador_plaza_temporal h
where h.autorizado_por is not null
  and not exists (select 1 from public.activadores a where a.usuario_id = h.autorizado_por);

select count(*) as huerfanos_plaza_temporal_cancelado
from public.activador_plaza_temporal h
where h.cancelado_por is not null
  and not exists (select 1 from public.activadores a where a.usuario_id = h.cancelado_por);

-- 5. Constraints actuales relevantes: schema, tabla, columna, constraint, ON DELETE, nullable.
select
  n.nspname as schema,
  c.relname as tabla,
  a.attname as columna,
  con.conname as constraint,
  case con.confdeltype
    when 'a' then 'NO ACTION'
    when 'r' then 'RESTRICT'
    when 'c' then 'CASCADE'
    when 'n' then 'SET NULL'
    when 'd' then 'SET DEFAULT'
  end as on_delete,
  not a.attnotnull as nullable,
  nref.nspname as ref_schema,
  cref.relname as ref_tabla
from pg_constraint con
join pg_class c on c.oid = con.conrelid
join pg_namespace n on n.oid = c.relnamespace
join pg_attribute a on a.attrelid = c.oid and a.attnum = any (con.conkey)
join pg_class cref on cref.oid = con.confrelid
join pg_namespace nref on nref.oid = cref.relnamespace
where con.contype = 'f'
  and (
    (n.nspname = 'public' and c.relname = 'activadores' and a.attname in ('usuario_id', 'auth_user_id'))
    or (n.nspname = 'public' and c.relname = 'equipo_lider_historial')
    or (n.nspname = 'public' and c.relname = 'activador_equipo_historial')
    or (n.nspname = 'public' and c.relname = 'activador_plaza_temporal')
  )
order by n.nspname, c.relname, a.attname;
