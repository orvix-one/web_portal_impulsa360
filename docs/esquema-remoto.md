# Esquemas remotos de Supabase

Esquema real de producción (no el de las migraciones), usado por el portal y la app móvil. Snapshot de 2026-10-28 obtenido del OpenAPI de PostgREST; no incluye índices, RLS, triggers ni permisos.

## activaciones

| Columna | Tipo | Obligatoria | Default | Nota |
|---|---|---|---|---|
| id | uuid | si | gen_random_uuid() | PK |
| created_at | timestamp with time zone | si | now() |  |
| impulsador | text |  |  |  |
| fecha_activacion | date |  |  |  |
| nombres_cliente | text |  |  |  |
| apellidos_cliente | text |  |  |  |
| ci_cliente | text |  |  |  |
| telefono_cliente | text |  |  |  |
| email_cliente | text |  |  |  |
| descargo_app | boolean |  |  |  |
| registro | boolean |  |  |  |
| cash_in | boolean |  |  |  |
| cash_out | boolean |  |  |  |
| p2p | boolean |  |  |  |
| qr_fisico | boolean |  |  |  |
| respaldo | boolean |  |  |  |
| hubo_error | boolean |  |  |  |
| descripcion_error | text |  |  |  |
| tipo_activacion | text |  |  |  |
| tamano_tienda | text |  |  |  |
| foto_url | text |  |  |  |
| creado_en | timestamp without time zone |  | now() |  |
| latitud | double precision |  |  |  |
| longitud | double precision |  |  |  |
| tipo_comercio | text |  |  |  |
| usuario_id | uuid |  |  | identificador unico |
| plaza | text |  |  |  |
| reactivacion_comercio | boolean |  |  |  |
| ciudad_activacion | text |  |  | Ciudad donde se realizó la activación (ej: Santa Cruz, La Paz, El Alto). |
| zona_activacion | text |  |  | Zona, barrio o distrito donde se realizó la activación. |
| base_activacion | text |  |  | Clasificación base de la activación (por ejemplo: comercio, tienda_barrio, transeunte, limbo). |
| es_reactivacion | boolean |  |  | Indica si la activación es una reactivación (true/false). |
| foto_respaldo_url | text |  |  | URL de la foto de respaldo adicional (ej: foto del activador, entorno, etc.). |
| estado_sync | text |  |  | Estado de sincronización del registro (ej: online, offline_pending, sincronizado). |
| dispositivo | text |  |  | Información del dispositivo desde el cual se realizó la activación (modelo, referencia). |
| foto_cash_in | text |  |  |  |
| tipo_tienda | text |  |  |  |
| rubro_comercio | text |  |  |  |
| rubro_comercio_otro | text |  |  |  |
| comercio_fuera_mercado | boolean |  |  |  |
| tipo_error | text |  |  |  |
| es_plaza_temporal | boolean | si | false |  |
| plaza_temporal | text |  |  |  |
| equipo_id_registro | uuid |  |  | FK equipos.id |
| plaza_id_registro | uuid |  |  | FK plazas.id |
| plaza_base_id_registro | uuid |  |  | FK plazas.id |
| plaza_efectiva_id_registro | uuid |  |  | FK plazas.id |
| equipo_numero_registro | bigint |  |  |  |
| equipo_nombre_registro | text |  |  |  |
| facturador_id_registro | uuid |  |  | FK facturadores.id |
| facturador_nombre_registro | text |  |  |  |
| lider_id_registro | uuid |  |  | FK activadores.usuario_id |
| lider_nombre_registro | text |  |  |  |
| plaza_base_registro | text |  |  |  |
| plaza_efectiva_registro | text |  |  |  |
| plaza_temporal_registro | boolean | si | false |  |
| plaza_temporal_asignacion_id | uuid |  |  | FK activador_plaza_temporal.id |
| distrito_gps | text |  |  |  |
| region_gps | text |  |  |  |
| creditos | boolean | si | false |  |
| remesas | boolean | si | false |  |

## activador_equipo_historial

| Columna | Tipo | Obligatoria | Default | Nota |
|---|---|---|---|---|
| id | uuid | si | gen_random_uuid() | PK |
| activador_id | uuid | si |  | FK activadores.usuario_id |
| equipo_id | uuid | si |  | FK equipos.id |
| inicio | timestamp with time zone | si |  |  |
| fin | timestamp with time zone |  |  |  |
| autorizado_por | uuid |  |  | FK activadores.usuario_id |
| motivo | text |  |  |  |
| created_at | timestamp with time zone | si | now() |  |

## activador_plaza_temporal

| Columna | Tipo | Obligatoria | Default | Nota |
|---|---|---|---|---|
| id | uuid | si | gen_random_uuid() | PK |
| activador_id | uuid | si |  | FK activadores.usuario_id |
| plaza_temporal_id | uuid | si |  | FK plazas.id |
| plaza_temporal | text | si |  |  |
| inicio | timestamp with time zone | si |  |  |
| fin | timestamp with time zone | si |  |  |
| motivo | text | si |  |  |
| autorizado_por | uuid | si |  | FK activadores.usuario_id |
| cancelado_at | timestamp with time zone |  |  |  |
| cancelado_por | uuid |  |  | FK activadores.usuario_id |
| created_at | timestamp with time zone | si | now() |  |
| tipo_zona | text | si | punto_temporal |  |
| ciudad_plaza | text |  |  |  |
| activo | boolean | si | true |  |

## activador_roles

| Columna | Tipo | Obligatoria | Default | Nota |
|---|---|---|---|---|
| usuario_id | uuid | si |  | PK; FK activadores.usuario_id |
| rol | text | si |  | PK |

## activadores

| Columna | Tipo | Obligatoria | Default | Nota |
|---|---|---|---|---|
| usuario_id | uuid | si | auth.uid() | PK |
| nombre | text | si |  |  |
| email | text |  |  |  |
| plaza | text |  |  | a que region o sector esta asignado el activador |
| estado | text | si | activo |  |
| rol | text | si | activador |  |
| inhabilitado_at | timestamp with time zone |  |  |  |
| motivo_inhabilitacion | text |  |  |  |
| lider_id | uuid |  |  |  |
| plaza_base | text |  |  |  |
| plaza_id | uuid |  |  | FK plazas.id |
| organizacion_pendiente | boolean | si | false |  |
| equipo_id | uuid |  |  | FK equipos.id |
| puede_activar | boolean | si | false |  |
| auth_user_id | uuid |  |  |  |

## equipo_lider_historial

| Columna | Tipo | Obligatoria | Default | Nota |
|---|---|---|---|---|
| id | uuid | si | gen_random_uuid() | PK |
| equipo_id | uuid | si |  | FK equipos.id |
| plaza_id | uuid | si |  | FK plazas.id |
| lider_id | uuid | si |  | FK activadores.usuario_id |
| inicio | timestamp with time zone | si |  |  |
| fin | timestamp with time zone |  |  |  |
| autorizado_por | uuid |  |  | FK activadores.usuario_id |
| motivo | text |  |  |  |
| created_at | timestamp with time zone | si | now() |  |

## equipos

| Columna | Tipo | Obligatoria | Default | Nota |
|---|---|---|---|---|
| id | uuid | si | gen_random_uuid() | PK |
| numero | bigint | si |  |  |
| nombre | text | si |  |  |
| facturador_id | uuid |  |  | FK facturadores.id |
| plaza_id | uuid | si |  | FK plazas.id |
| lider_actual_id | uuid |  |  | FK activadores.usuario_id |
| activo | boolean | si | true |  |
| created_at | timestamp with time zone | si | now() |  |

## facturadores

| Columna | Tipo | Obligatoria | Default | Nota |
|---|---|---|---|---|
| id | uuid | si | gen_random_uuid() | PK |
| codigo | text | si |  |  |
| nombre | text | si |  |  |
| activo | boolean | si | true |  |
| created_at | timestamp with time zone | si | now() |  |
| usuario_id | uuid |  |  | FK activadores.usuario_id |

## notificaciones

| Columna | Tipo | Obligatoria | Default | Nota |
|---|---|---|---|---|
| id | uuid | si | gen_random_uuid() | PK |
| titulo | text | si |  |  |
| mensaje | text | si |  |  |
| alcance | text | si |  |  |
| usuario_objetivo_id | uuid |  |  |  |
| creado_por | text | si |  |  |
| created_at | timestamp with time zone | si | now() |  |
| tipo_audiencia | text | si | all |  |
| rol_objetivo | text |  |  |  |
| destinatarios_total | integer |  |  |  |

## notificaciones_destinatarios

| Columna | Tipo | Obligatoria | Default | Nota |
|---|---|---|---|---|
| notificacion_id | uuid | si |  | PK; FK notificaciones.id |
| usuario_id | uuid | si |  | PK |
| enviada_at | timestamp with time zone | si | now() |  |
| leida_at | timestamp with time zone |  |  |  |
| id | uuid | si | gen_random_uuid() |  |

## plazas

| Columna | Tipo | Obligatoria | Default | Nota |
|---|---|---|---|---|
| id | uuid | si | gen_random_uuid() | PK |
| nombre | text | si |  |  |
| nombre_normalizado | text | si |  |  |
| activa | boolean | si | true |  |
| created_at | timestamp with time zone | si | now() |  |

## telemetria_eventos

| Columna | Tipo | Obligatoria | Default | Nota |
|---|---|---|---|---|
| id | uuid | si | gen_random_uuid() | PK |
| usuario_id | uuid | si | auth.uid() |  |
| received_at | timestamp with time zone | si | now() |  |
| event_name | text | si |  |  |
| occurred_at | timestamp with time zone |  |  |  |
| run_id | text |  |  |  |
| app_version | text |  |  |  |
| build_number | text |  |  |  |
| platform | text |  |  |  |
| os_version | text |  |  |  |
| app_state | text |  |  |  |
| screen | text |  |  |  |
| phase | text |  |  |  |
| pending_count_bucket | text |  |  |  |
| photo_size_bucket | text |  |  |  |
| sync_stage | text |  |  |  |
| error_category | text |  |  |  |
| native_exit_reason | text |  |  |  |
| occurrence_count | integer | si | 1 |  |
| event_id | uuid |  |  |  |
| exit_timestamp | timestamp with time zone |  |  |  |
| previous_last_state | text |  |  |  |

## Funciones (RPC)

| Funcion | Argumentos |
|---|---|
| actualizar_equipo_organizacion | p_activo: boolean, p_equipo_id: uuid, p_facturador_id: uuid, p_inicio?: timestamp with time zone, p_lider_id: uuid, p_motivo?: text, p_nombre: text, p_numero: bigint, p_plaza_id: uuid |
| asignar_activador_equipo | p_activador_id: uuid, p_equipo_id: uuid, p_inicio?: timestamp with time zone, p_motivo?: text |
| asignar_equipos_lider | p_equipo_ids: uuid[], p_inicio?: timestamp with time zone, p_lider_id: uuid, p_motivo?: text |
| asignar_lider_equipo | p_equipo_id: uuid, p_inicio?: timestamp with time zone, p_lider_id: uuid, p_motivo?: text |
| control_activaciones_detalle | p_activador_id: uuid, p_desde?: date, p_equipo_id: uuid, p_hasta?: date |
| control_activadores_jerarquia | p_desde?: date, p_hasta?: date |
| plaza_efectiva_activador | p_activador_id: uuid, p_momento?: timestamp with time zone |
| puede_leer_foto_activacion_equipo | p_nombre: text |
| reasignar_y_eliminar_plaza | p_plaza_destino: uuid, p_plaza_origen: uuid |
| registrar_eventos_telemetria | p_eventos: jsonb |
| unaccent | : text |
| validar_elegibilidad_reactivacion | p_ci?: text, p_fecha_referencia?: date, p_registro_id?: uuid, p_telefono?: text, p_tipo_activacion?: text |

## Notas

- Referenciadas en el código pero ausentes en `activaciones`: `nombre_comercio`, `comercio`, `cliente`, `resultado`, `estado`, `foto_cashin`, `updated_at`.
- No existe `get_database_size_bytes`; la página Capacidad usa una estimación.
