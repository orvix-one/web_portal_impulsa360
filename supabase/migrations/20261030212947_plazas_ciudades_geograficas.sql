-- Run manually on prod on 2026-10-29/30 by the former dev (as run: legacy/manual/202610290001_plazas_ciudades_geograficas_as_run.sql).
-- Prod is recorded as applied via `migration repair`; this file is never executed there. Same schema effect, without prod-row checks.

alter table public.plazas
  add column if not exists es_ciudad_geografica boolean not null default false,
  add column if not exists aliases text[] not null default '{}'::text[];

update public.plazas
set es_ciudad_geografica = true
where nombre in (
  '4 cañadas', 'Camiri', 'Cochabamba', 'Concepcion', 'El Alto',
  'La Paz', 'Montero', 'Oruro', 'Potosi', 'Riberalta',
  'San Ignacio', 'Santa Cruz de la Sierra', 'Sucre', 'Tarija', 'Trinidad'
);

update public.plazas p
set aliases = array(
  select distinct expanded.alias
  from unnest(
    p.aliases || case p.nombre
      when '4 cañadas' then array['4 Cañadas', 'Cuatro Cañadas']::text[]
      when 'Concepcion' then array['Concepción']::text[]
      when 'Potosi' then array['Potosí']::text[]
      when 'San Ignacio' then array['San Ignacio de Velasco']::text[]
      when 'Santa Cruz de la Sierra' then array['Santa Cruz']::text[]
      else '{}'::text[]
    end
  ) as expanded(alias)
  where btrim(expanded.alias) <> ''
)
where nombre in ('4 cañadas', 'Concepcion', 'Potosi', 'San Ignacio', 'Santa Cruz de la Sierra');

create policy plazas_select_ciudades_geograficas_activas
  on public.plazas
  for select
  to authenticated
  using (activa = true and es_ciudad_geografica = true);

grant select (id, nombre, nombre_normalizado, activa, es_ciudad_geografica, aliases)
  on public.plazas to authenticated;
