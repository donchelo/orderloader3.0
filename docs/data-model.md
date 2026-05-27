# OrderLoader — Modelo de Datos

## Tabla: `pedidos_maestro`

Registro principal de cada orden de compra recibida por email.

| Columna | Tipo | Descripción |
|---|---|---|
| `id` | INTEGER PK | Autoincremental |
| `nit_cliente` | TEXT | NIT del cliente (extraído de CardCode, sin prefijo) |
| `orden_compra` | TEXT UNIQUE | Número de OC — identificador principal (ej. `OC-2025-001`) |
| `fecha_recepcion` | TEXT | Timestamp de inserción en DB (ISO 8601) |
| `fecha_solicitado` | TEXT | DocDate del PDF — fecha en que el cliente emitió la OC |
| `fecha_entrega_general` | TEXT | DocDueDate del PDF — fecha de entrega solicitada |
| `cliente_nombre` | TEXT | Nombre del cliente (carpeta en el sistema) |
| `subtotal` | REAL | Suma de `precio_unitario × cantidad` de todas las líneas |
| `estado` | TEXT | Estado actual en el pipeline (ver ciclo abajo) |
| `notas` | TEXT | Metadatos internos (ej. `TaxDate:20250115`) |
| `fase_actual` | INTEGER | Número del último step completado (0–7) |
| `ts_parsed` | TEXT | Timestamp de step 1 exitoso |
| `ts_sap_query` | TEXT | Timestamp de step 3 exitoso |
| `ts_sap_upload` | TEXT | Timestamp de step 4 exitoso |
| `ts_validated` | TEXT | Timestamp de step 2 exitoso |
| `ts_notified` | TEXT | Timestamp de step 6 exitoso |
| `sap_doc_entry` | INTEGER | DocEntry en SAP (ID interno) — NULL hasta step 4 |
| `sap_doc_num` | TEXT | DocNum en SAP (número legible) — NULL hasta step 4 |
| `sap_existe` | INTEGER | `1` si ya existía en SAP (duplicado), `0` si es nuevo, NULL si no verificado |
| `sap_query_resultado` | TEXT | JSON de la respuesta de SAP al verificar duplicados |
| `validacion_resultado` | TEXT | JSON con errores de validación de step 2 |
| `items_excluidos` | TEXT | JSON array de SKUs excluidos por step 3 (no encontrados en catálogo) |
| `error_msg` | TEXT | Mensaje del último error — truncado a 250 chars |
| `carpeta_origen` | TEXT | Path absoluto a la carpeta del correo en `.data/pedidos/raw/` |
| `notificacion_enviada` | INTEGER | `1` si step 6 envió el email de confirmación al cliente |
| `costo_ia_usd` | REAL | Costo estimado en USD del parsing con Claude (step 1) |

---

## Ciclo de vida de un pedido (`estado`)

```
                  ┌─────────────────────────────┐
  Correo recibido │         NUEVO               │ (creado por step 1)
                  └─────────────┬───────────────┘
                                │ step 1: Claude extrae JSON del PDF
                  ┌─────────────▼───────────────┐
                  │         PARSED              │
                  └─────────────┬───────────────┘
                                │ step 2: validación formato + check duplicados SAP
               ┌────────────────┼────────────────────┐
               │                │                    │
    ┌──────────▼──────┐ ┌───────▼──────┐   ┌────────▼────────┐
    │  ERROR_PARSE    │ │ERROR_DUPLICADO│   │  PARSE_VALIDO   │
    │ (formato inválido│ │(ya existe SAP)│   │                 │
    └─────────────────┘ └──────────────┘   └────────┬────────┘
                                                     │ step 3: busca SKUs en catálogo SAP
                                          ┌──────────┴──────────┐
                                          │                     │
                               ┌──────────▼──────┐  ┌──────────▼──────┐
                               │  ERROR_CATALOG  │  │   CATALOG_OK    │
                               │(ningún SKU existe│  │                 │
                               └─────────────────┘  └────────┬────────┘
                                                              │ step 4: crea Sales Order en SAP
                                               ┌─────────────┼─────────────────┐
                                               │             │                 │
                                    ┌──────────▼──┐ ┌────────▼──────┐ ┌───────▼──────┐
                                    │ ERROR_ITEMS │ │   ERROR_SAP   │ │ SAP_MONTADO  │ ← terminal ✓
                                    │(sin ítems   │ │(SAP rechazó)  │ │              │
                                    │ válidos)    │ └───────────────┘ └──────────────┘
                                    └─────────────┘
```

**Estados terminales:**
- `SAP_MONTADO` — procesado exitosamente, orden creada en SAP
- `ERROR_DUPLICADO` — ya existía en SAP, no se vuelve a subir

**Estados de error recuperables** (se pueden resetear manualmente para reintentar):
- `ERROR_PARSE`, `ERROR_CATALOG`, `ERROR_ITEMS`, `ERROR_SAP`

---

## Tabla: `pedidos_detalle`

Líneas de items de cada OC. FK → `pedidos_maestro.orden_compra`.

| Columna | Tipo | Descripción |
|---|---|---|
| `orden_compra` | TEXT FK | Referencia a `pedidos_maestro` |
| `codigo_producto` | TEXT | SupplierCatNum — código del cliente (no el ItemCode de SAP) |
| `descripcion` | TEXT | FreeText del PDF |
| `cantidad` | REAL | Quantity (siempre entero positivo en producción) |
| `precio_unitario` | REAL | UnitPrice del PDF |
| `subtotal_item` | REAL | `cantidad × precio_unitario` |
| `fecha_entrega` | TEXT | DeliveryDate por línea (ISO 8601) |

---

## Tabla: `pipeline_log`

Audit trail de cada operación del pipeline por OC.

| Columna | Descripción |
|---|---|
| `orden_compra` | OC afectada (NULL para logs de nivel pipeline) |
| `fase` | Número de step (0–7) |
| `fase_nombre` | Nombre legible (`parse`, `validate`, `sap_catalog`, `upload`, etc.) |
| `estado_resultado` | `OK` / `ERROR` / `WARN` |
| `mensaje` | Descripción de la operación |
| `input_tokens` | Tokens de entrada AI (solo step 1) |
| `output_tokens` | Tokens de salida AI (solo step 1) |
| `model` | Modelo AI usado (ej. `claude-sonnet-4-6`) |

---

## Tabla: `pipeline_triggers`

Audit log de cada trigger del pipeline (quién lo disparó y cuándo).

| Columna | Descripción |
|---|---|
| `ts` | Timestamp del trigger |
| `source` | User-Agent del cliente HTTP |
| `ip` | IP del cliente |
| `resultado` | `iniciado` / `ya_corriendo` / `rate_limited` / `error` |

---

## Tabla: `_migrations`

Control de versiones de migraciones de schema. No modificar manualmente.

| Columna | Descripción |
|---|---|
| `name` | Nombre único de la migración (ej. `001_add_items_excluidos`) |
| `applied_at` | Timestamp de aplicación |

---

## Campos frecuentemente confundidos

| Campo | Qué es | Qué NO es |
|---|---|---|
| `sap_existe = 1` | La OC ya existía en SAP al momento del check de step 2 | Que la orden fue subida exitosamente |
| `sap_existe = 0` | La OC NO existía en SAP (nueva) | Que la orden fue subida (puede seguir fallando en step 4) |
| `sap_existe = NULL` | No se verificó (SAP no disponible en step 2) | Error |
| `sap_doc_entry` | ID interno de SAP (DocEntry) — para consultas API | Número de documento legible |
| `sap_doc_num` | Número legible de SAP (DocNum) — para mostrar al usuario | ID interno |
| `items_excluidos` | SKUs del cliente que step 3 no encontró en catálogo SAP | Artículos rechazados por SAP en step 4 |
| `carpeta_origen` | Path al sub-folder de la OC específica dentro del correo | Path al correo completo |
