# Referencia completa: CLI de Meta Ads (oficial)

> Herramienta: `meta-ads` v1.0.1 — Lanzada el 29 de abril de 2026  
> Fuentes: documentación oficial Meta Developers, `meta --help`, pruebas en cuenta `act_166443567`  
> Esta es la CLI **oficial de Meta**, distinta de herramientas de terceros como `meta-ads-cli` de Attainment Labs.

---

## Por qué existe

La Marketing API de Meta es poderosa pero repetitiva: autenticación, paginación, formateo de salida, manejo de errores. El CLI envuelve todo eso para que puedas crear campañas desde la terminal, un script de CI/CD, o un agente de IA — sin escribir código.

**Características de diseño clave:**
- Todo recurso nuevo se crea en estado `PAUSED` por defecto (seguridad contra gasto accidental)
- Las credenciales van en variables de entorno, nunca en los argumentos (no quedan en el historial del shell)
- Exit codes estándar: `0` (éxito), `3` (error de auth), `4` (error de API)
- Construido sobre Marketing API v25.0+

---

## Instalación

```bash
# Con uv (recomendado — entorno aislado, no ensucia el Python del sistema)
uv tool install meta-ads

# Con pip
pip install meta-ads
```

**Requisito:** Python 3.12 o superior.

Verificar instalación:

```bash
meta --version
meta --help
```

Si dice `command not found`, agregar `~/.local/bin` al PATH:

```bash
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.bashrc
source ~/.bashrc
```

---

## Autenticación y variables de entorno

El CLI necesita tres variables. Agregarlas a `~/.bashrc` o `~/.zshrc`:

```bash
export ACCESS_TOKEN="EAAB...tu-token-largo"   # System User token (no caduca)
export AD_ACCOUNT_ID="act_123456789"           # SIEMPRE con el prefijo act_
export BUSINESS_ID="987654321098765"           # Número en la URL de Business Settings
```

Recargar:

```bash
source ~/.bashrc
meta auth status   # debe mostrar a quién pertenece el token y sus permisos
```

### Obtener el ACCESS_TOKEN (System User — no caduca)

1. Ir a [business.facebook.com/settings](https://business.facebook.com/settings)
2. **Users → System Users → Add** → nombre `cli-token` → rol Admin → Create
3. Seleccionar el usuario → **Add Assets** → Ad Accounts → permisos: **Manage Ad Account**
4. Con el usuario seleccionado → **Generate New Token**
   - Token expiration: **Never**
   - Permisos mínimos: `ads_read`, `ads_management`, `business_management`, `read_insights`
5. Copiar inmediatamente — solo se muestra una vez

### Obtener AD_ACCOUNT_ID

En [adsmanager.facebook.com](https://adsmanager.facebook.com) → selector arriba a la izquierda.  
Formato obligatorio: `act_` + el número. Ejemplo: `act_166443567`.

### Obtener BUSINESS_ID

En Business Settings → la URL del navegador contiene `?business_id=XXXXXXX`.

### Múltiples cuentas (script wrapper)

```bash
# ~/meta-envs/cliente1.env
ACCESS_TOKEN=EAAB...
AD_ACCOUNT_ID=act_111111
BUSINESS_ID=222222222

# ~/bin/metac (script wrapper)
#!/bin/bash
CLIENT="${1#--client=}"; shift
source "$HOME/meta-envs/${CLIENT}.env"
exec meta "$@"

# Uso:
metac --client=cliente1 ads campaign list
```

---

## Flags globales

Van **antes** del subcomando:

```bash
meta -o json ads campaign list           # Salida JSON
meta -o plain ads campaign list          # Texto plano (para pipes con awk/cut/sort)
meta -o table ads campaign list          # Tabla legible (default)
meta --no-color ads campaign list        # Sin colores (para logs)
meta --no-input ads campaign create ...  # Sin prompts interactivos (scripts/agentes)
meta --force ads campaign delete ...     # Omite confirmaciones
meta --debug ads insights get ...        # Imprime request HTTP y respuesta completa
```

**Combinación con jq:**

```bash
meta -o json ads campaign list | jq '.[] | {id, name, status, daily_budget}'
meta -o json ads insights get --date-preset last_7d | jq '.[0].spend'
```

---

## Estructura de una campaña

```
Campaña (campaign)           ← objetivo, presupuesto total (opcional)
└── Ad Set (adset)           ← targeting, presupuesto, optimización, bid
    └── Ad (ad)              ← referencia al creative
        └── Creative         ← imagen/video + copy + CTA + URL destino
```

---

## CAMPAIGNS

### Listar

```bash
meta ads campaign list               # últimas 10
meta ads campaign list -l 25
meta -o json ads campaign list
meta -o json ads campaign list | jq '.[] | {id, name, status, daily_budget}'
```

### Ver detalle

```bash
meta ads campaign get CAMPAIGN_ID
meta -o json ads campaign get CAMPAIGN_ID
```

### Crear

```bash
meta ads campaign create \
  --name "Nombre de la campaña" \
  --objective OBJETIVO \
  --daily-budget MONTO_EN_CENTAVOS \
  --status active          # default: paused
```

**Objetivos disponibles:**

| Flag | Cuándo usarlo | Notas |
|---|---|---|
| `outcome_awareness` | Brand awareness, alcance, impresiones | Optimization goals: `reach`, `impressions` |
| `outcome_traffic` | Clics a URL (WhatsApp, landing page) | Usar con `link_clicks` o `landing_page_views` |
| `outcome_engagement` | Interacciones, mensajes, seguidores | `conversations` requiere creative especial |
| `outcome_leads` | Formularios de leads dentro de Meta | Optimization goal: `lead_generation` |
| `outcome_sales` | Conversiones con pixel | Requiere `--pixel-id` en el adset |
| `outcome_app_promotion` | Instalaciones de app | Optimization goal: `app_installs` |

**Presupuesto en "centavos" (unidad mínima × 100):**

| Moneda | Equivalencia |
|---|---|
| COP | $5.000 COP → `500000` \| $10.000 COP → `1000000` |
| USD | $50.00 → `5000` \| $10.00 → `1000` |
| MXN | $100 MXN → `10000` |

**Presupuesto a nivel de adset (en vez de campaña):**

```bash
# 1. Campaña sin presupuesto propio
meta ads campaign create --name "..." --objective outcome_traffic --adset-budget-sharing

# 2. Cada adset tiene su propio presupuesto
meta ads adset create CAMPAIGN_ID --name "..." --daily-budget 500000 ...
```

### Actualizar

```bash
meta ads campaign update CAMPAIGN_ID --name "Nuevo nombre"
meta ads campaign update CAMPAIGN_ID --status paused      # active | paused | archived
meta ads campaign update CAMPAIGN_ID --daily-budget 1000000
meta ads campaign update CAMPAIGN_ID --lifetime-budget 5000000
```

### Pausar / archivar / eliminar

```bash
meta ads campaign update CAMPAIGN_ID --status paused
meta ads campaign update CAMPAIGN_ID --status archived

# Eliminar (pide confirmación interactiva)
echo "y" | meta ads campaign delete CAMPAIGN_ID

# Eliminar sin prompt (scripts)
meta --no-input --force ads campaign delete CAMPAIGN_ID
```

---

## AD SETS

### Listar

```bash
meta ads adset list                    # todos en el ad account
meta ads adset list CAMPAIGN_ID        # solo los de una campaña
meta -o json ads adset list CAMPAIGN_ID
```

### Ver detalle

```bash
meta ads adset get ADSET_ID
meta -o json ads adset get ADSET_ID
```

### Crear

```bash
meta ads adset create CAMPAIGN_ID \
  --name "Nombre del adset" \
  --optimization-goal GOAL \
  --billing-event EVENT \
  --bid-amount MONTO_EN_CENTAVOS \       # requerido en muchos objetivos y cuentas COP
  --targeting-countries CO,MX,AR \       # códigos ISO 3166-1 alfa-2, separados por coma
  --daily-budget 500000 \                # omitir si la campaña usa CBO (adset-budget-sharing)
  --start-time "2026-06-01T00:00:00-0500" \  # ISO 8601 con timezone
  --status active
```

**Optimization goals disponibles:**

| Goal | Compatible con objetivo | Notas |
|---|---|---|
| `link_clicks` | `outcome_traffic` | El más común para tráfico |
| `landing_page_views` | `outcome_traffic` | Mide visitas reales a la página |
| `reach` | `outcome_awareness` | Maximiza personas únicas alcanzadas |
| `impressions` | `outcome_awareness` | Maximiza impresiones totales |
| `conversations` | `outcome_engagement` | Requiere creative tipo "Click to Message" — no compatible con URL directa |
| `post_engagement` | `outcome_engagement` | Likes, comments, shares |
| `page_likes` | `outcome_engagement` | Seguidores de la página |
| `event_responses` | `outcome_engagement` | RSVPs a eventos |
| `lead_generation` | `outcome_leads` | Formularios Meta |
| `offsite_conversions` | `outcome_sales` | Requiere `--pixel-id` |
| `value` | `outcome_sales` | Optimiza hacia mayor ROAS, requiere `--pixel-id` |
| `app_installs` | `outcome_app_promotion` | |
| `thruplay` | Cualquiera con video | Video visto al 97% o 15 segundos |

**Billing events disponibles:**

| Event | Cuándo se cobra |
|---|---|
| `impressions` | Por cada 1000 impresiones (el más común) |
| `link_clicks` | Por clic en el enlace |
| `clicks` | Por cualquier clic |
| `page_likes` | Por like a la página |
| `post_engagement` | Por interacción con post |
| `thruplay` | Por video completado |
| `app_installs` | Por instalación de app |

**Para campañas con pixel (conversiones):**

```bash
meta ads adset create CAMPAIGN_ID \
  --name "Conversiones - Colombia" \
  --optimization-goal offsite_conversions \
  --billing-event impressions \
  --pixel-id PIXEL_ID \
  --custom-event-type purchase \
  --bid-amount 5000000 \
  --targeting-countries CO \
  --status active
```

**Custom event types:** `purchase` | `lead` | `contact` | `complete_registration` | `add_to_cart` | `add_to_wishlist` | `add_payment_info` | `initiated_checkout` | `content_view` | `search` | `subscribe` | `start_trial` | `schedule` | `submit_application` | `donate` | `find_location` | `customize_product` | `other`

**Targeting avanzado (no disponible aún en el CLI — requiere API directa):**
- Rangos de edad (min/max)
- Género (0=todos, 1=hombres, 2=mujeres)
- Intereses (con IDs de Meta)
- Plataformas: facebook, instagram
- Placements: feed, stories, reels, stream

### Actualizar

```bash
meta ads adset update ADSET_ID --status paused
meta ads adset update ADSET_ID --daily-budget 1000000
meta ads adset update ADSET_ID --bid-amount 2000000
meta ads adset update ADSET_ID --end-time "2026-12-31T23:59:59-0500"
meta ads adset update ADSET_ID --name "Nuevo nombre"
```

---

## CREATIVES

### Listar

```bash
meta ads creative list
meta ads creative list -l 25
meta -o json ads creative list
```

### Ver detalle

```bash
meta ads creative get CREATIVE_ID
meta -o json ads creative get CREATIVE_ID
```

### Crear — imagen simple (Standard)

```bash
meta ads creative create \
  --name "Nombre del creative" \
  --page-id PAGE_ID \                    # ID de la página de Facebook (requerido)
  --image ./imagen.png \
  --body "Texto principal del anuncio" \
  --title "Titular debajo de la imagen" \
  --description "Descripción secundaria (opcional)" \
  --link-url "https://destino.com" \
  --call-to-action contact_us
```

**Formatos de imagen soportados:** `jpg`, `png`, `gif`, `bmp`, `webp`

**Aspectos ratios recomendados:** 1:1 (cuadrado), 4:5 (vertical), 9:16 (stories/reels), 16:9 (horizontal)

**CTAs disponibles:**

| Flag | Texto visible en el anuncio |
|---|---|
| `contact_us` | Contáctanos |
| `learn_more` | Más información |
| `shop_now` | Comprar ahora |
| `sign_up` | Registrarse |
| `get_quote` | Obtener presupuesto |
| `get_offer` | Ver oferta |
| `apply_now` | Solicitar ahora |
| `book_travel` | Reservar |
| `buy_now` | Comprar |
| `download` | Descargar |
| `open_link` | Abrir enlace |
| `subscribe` | Suscribirse |
| `watch_more` | Ver más |
| `no_button` | Sin botón |

### Crear — video

```bash
meta ads creative create \
  --name "Video Ad" \
  --page-id PAGE_ID \
  --video ./video.mp4 \
  --body "Texto del anuncio" \
  --title "Titular" \
  --link-url "https://ejemplo.com" \
  --call-to-action learn_more
```

**Formatos de video soportados:** `mp4`, `mov`, `avi`, `mkv`, `wmv`

### Crear — Dynamic Creative Optimization (DCO)

Meta prueba combinaciones automáticamente y concentra presupuesto en las ganadoras.

```bash
meta ads creative create \
  --name "DCO Creative" \
  --page-id PAGE_ID \
  --link-url "https://ejemplo.com" \
  --images ./img1.png --images ./img2.png --images ./img3.png \
  --bodies "Texto opción 1" --bodies "Texto opción 2" \
  --titles "Titular A" --titles "Titular B" \
  --call-to-actions contact_us --call-to-actions learn_more
```

**Límites DCO:**
- Máximo 10 imágenes o 10 videos
- Máximo 5 títulos
- Máximo 5 textos (bodies)
- Máximo 5 descripciones
- Máximo 5 CTAs

**Cuándo DCO falla:**  
Si mezclas múltiples `--images` con múltiples `--call-to-actions` puede dar error: `"una lista de activos solo puede tener un formato de anuncio"`. En ese caso, crear creativos separados y ads separados — Meta igual aprenderá cuál performa mejor.

### Con cuenta de Instagram

```bash
meta ads creative create \
  --name "Ad en Instagram y Facebook" \
  --page-id PAGE_ID \
  --instagram-actor-id IG_ACCOUNT_ID \
  --image ./imagen.png \
  --body "Texto" \
  --link-url "https://..." \
  --call-to-action learn_more
```

Para obtener el `instagram-actor-id`: Business Settings → Instagram Accounts → seleccionar cuenta → el ID está en la URL.

### Actualizar creative

```bash
meta ads creative update CREATIVE_ID --body "Nuevo texto"
meta ads creative update CREATIVE_ID --image ./nueva-imagen.png
meta ads creative update CREATIVE_ID --title "Nuevo titular"
meta ads creative update CREATIVE_ID --call-to-action learn_more
meta ads creative update CREATIVE_ID --link-url "https://nueva-url.com"
```

> Meta tiene restricciones post-creación. Si el campo no se puede actualizar, crear un creative nuevo y reasignarlo: `meta ads ad update AD_ID --creative-id NUEVO_CREATIVE_ID`

---

## ADS

### Listar

```bash
meta ads ad list                       # todos en el ad account
meta ads ad list ADSET_ID              # solo los de un adset
meta -o json ads ad list ADSET_ID
```

### Ver detalle

```bash
meta ads ad get AD_ID
meta -o json ads ad get AD_ID
```

### Crear

```bash
# Básico
meta ads ad create ADSET_ID \
  --name "Nombre del ad" \
  --creative-id CREATIVE_ID \
  --status active

# Con tracking de pixel
meta ads ad create ADSET_ID \
  --name "Ad con pixel" \
  --creative-id CREATIVE_ID \
  --pixel-id PIXEL_ID \
  --status active

# Con tracking specs JSON personalizado
meta ads ad create ADSET_ID \
  --name "Ad tracking custom" \
  --creative-id CREATIVE_ID \
  --tracking-specs '[{"action.type":["offsite_conversion"],"fb_pixel":[PIXEL_ID]}]' \
  --status active
```

### Actualizar

```bash
meta ads ad update AD_ID --status paused
meta ads ad update AD_ID --status active
meta ads ad update AD_ID --creative-id NUEVO_CREATIVE_ID   # cambiar imagen/copy
meta ads ad update AD_ID --name "Nuevo nombre"
```

---

## INSIGHTS (métricas y análisis)

### Uso básico

```bash
meta ads insights get                              # últimos 30 días, nivel cuenta
meta ads insights get --date-preset last_7d
meta ads insights get --since 2026-05-01 --until 2026-05-07
```

**Date presets disponibles:**

| Preset | Período |
|---|---|
| `today` | Hoy |
| `yesterday` | Ayer |
| `last_3d` | Últimos 3 días |
| `last_7d` | Últimos 7 días |
| `last_14d` | Últimos 14 días |
| `last_30d` | Últimos 30 días (default) |
| `last_90d` | Últimos 90 días |
| `this_month` | Mes actual |
| `last_month` | Mes anterior |

### Filtrar por entidad

```bash
meta ads insights get --campaign-id CAMPAIGN_ID   # solo esa campaña
meta ads insights get --adset-id ADSET_ID          # solo ese adset
meta ads insights get --ad-id AD_ID                # solo ese anuncio
```

### Campos / métricas

```bash
meta ads insights get \
  --fields spend,impressions,clicks,ctr,cpc,reach,frequency,actions,action_values,roas
```

**Campos disponibles:**

| Campo | Qué mide |
|---|---|
| `spend` | Gasto total |
| `impressions` | Impresiones totales |
| `reach` | Personas únicas alcanzadas |
| `frequency` | Promedio de veces que cada persona vio el anuncio |
| `clicks` | Clics totales (todos los tipos) |
| `ctr` | Click-through rate (clicks/impressions) |
| `cpc` | Costo por clic |
| `cpm` | Costo por mil impresiones |
| `actions` | Conversiones y eventos (array con tipos) |
| `action_values` | Valor de las conversiones |
| `cost_per_action_type` | Costo por cada tipo de conversión |
| `conversions` | Total de conversiones |
| `roas` | Return on Ad Spend |
| `video_p25_watched_actions` | Usuarios que vieron el 25% del video |
| `video_p50_watched_actions` | Usuarios que vieron el 50% del video |
| `video_p75_watched_actions` | Usuarios que vieron el 75% del video |
| `video_p100_watched_actions` | Usuarios que vieron el 100% del video |

### Granularidad temporal

```bash
meta ads insights get --time-increment daily    # una fila por día
meta ads insights get --time-increment weekly
meta ads insights get --time-increment monthly
meta ads insights get --time-increment all_days  # total agregado (default)
```

### Breakdowns (segmentar resultados)

```bash
meta ads insights get --breakdown age
meta ads insights get --breakdown gender
meta ads insights get --breakdown country
meta ads insights get --breakdown publisher_platform   # Facebook vs Instagram
meta ads insights get --breakdown device_platform      # desktop vs mobile
meta ads insights get --breakdown platform_position    # feed, stories, reels, etc.
meta ads insights get --breakdown impression_device    # tipo de dispositivo

# Combinar breakdowns (repetir el flag):
meta ads insights get --breakdown publisher_platform --breakdown age
meta ads insights get --breakdown country --breakdown gender
```

### Ordenar y limitar

```bash
meta ads insights get --sort spend_descending -l 20
meta ads insights get --sort impressions_ascending -l 10
meta ads insights get --sort ctr_descending -l 5
```

### Ventanas de atribución (attribution windows)

Para ver conversiones con ventana específica, agregar el campo con sufijo:

```
1d_click, 1d_view, 7d_click, 7d_view, 28d_click, 28d_view
```

Ejemplo (via `--fields` con acción específica):

```bash
meta -o json ads insights get \
  --campaign-id CAMPAIGN_ID \
  --fields "actions,action_values" \
  --date-preset last_30d
```

### Ejemplos útiles

```bash
# Qué anuncio tiene mejor CTR esta semana
meta -o json ads insights get \
  --campaign-id CAMPAIGN_ID \
  --date-preset last_7d \
  --fields spend,clicks,ctr,reach \
  --time-increment all_days \
  | jq 'sort_by(.ctr) | reverse | .[:3]'

# Gasto diario del mes
meta -o json ads insights get \
  --date-preset this_month \
  --fields spend,impressions,clicks \
  --time-increment daily \
  | jq '.[] | {date_start, spend, clicks}'

# Breakdown por plataforma
meta ads insights get \
  --date-preset last_7d \
  --breakdown publisher_platform \
  --fields spend,impressions,ctr

# Resumen de gasto de la cuenta
meta -o json ads insights get --date-preset last_30d | jq '.[0].spend'
```

---

## PIXELS / DATASETS

```bash
meta ads dataset list                                        # listar pixels
meta ads dataset get PIXEL_ID                               # detalle
meta ads dataset create --name "Mi Pixel"                   # crear
meta ads dataset connect PIXEL_ID --ad-account-id act_123  # vincular a cuenta
meta ads dataset connect PIXEL_ID --catalog-id 555666       # vincular a catálogo
meta ads dataset assign-user PIXEL_ID                       # asignar usuario
meta ads dataset disconnect PIXEL_ID                        # desvincular
```

---

## CATÁLOGOS Y PRODUCTOS (e-commerce / DPA)

### Catálogos

```bash
meta ads catalog list
meta ads catalog get CATALOG_ID
meta ads catalog create --name "Mi Catálogo"
meta ads catalog update CATALOG_ID --name "Nombre nuevo"
echo "y" | meta ads catalog delete CATALOG_ID
```

### Producto items

```bash
meta ads product-item create \
  --catalog-id CATALOG_ID \
  --retailer-id sku_001 \              # tu ID interno de producto (SKU)
  --name "Camisa Azul Talla M" \
  --url "https://tienda.com/camisa-azul" \
  --price "99900" \                    # en centavos de la moneda (99900 = $999 COP)
  --currency "COP" \
  --image-url "https://tienda.com/camisa-azul.jpg"

meta ads product-item list --catalog-id CATALOG_ID
meta ads product-item get PRODUCT_ITEM_ID
```

### Product feeds

```bash
meta ads product-feed list --catalog-id CATALOG_ID
```

### Product sets

```bash
meta ads product-set list --catalog-id CATALOG_ID
```

---

## PÁGINAS DE FACEBOOK

```bash
meta ads page list                    # listar páginas accesibles (muestra ID)
meta ads page get PAGE_ID             # detalle de una página
meta -o json ads page list
```

---

## PÁGINAS DE FACEBOOK — IDs de esta cuenta

| Recurso | ID |
|---|---|
| Página Facebook | `203149382889886` (Ai4u Software) |
| Ad Account | `act_166443567` |
| Moneda | COP (Colombia) |
| Zona horaria | America/Bogota |
| WhatsApp destino | `+57 302 490 6414` |

---

## Recetas probadas

### Click to WhatsApp — Colombia (funciona)

```bash
# 1. Campaña
meta ads campaign create \
  --name "Producto - WhatsApp Colombia" \
  --objective outcome_traffic \
  --daily-budget 500000 \
  --status active

# 2. Ad Set (bid-amount es requerido en cuentas COP)
meta ads adset create CAMPAIGN_ID \
  --name "Segmento - Colombia" \
  --optimization-goal link_clicks \
  --billing-event impressions \
  --bid-amount 500000 \
  --targeting-countries CO \
  --status active

# 3. Creative (link-url = wa.me con mensaje pre-llenado)
meta ads creative create \
  --name "Creative nombre" \
  --page-id 203149382889886 \
  --image ./imagen.png \
  --body "Texto del anuncio..." \
  --title "Titular" \
  --link-url "https://wa.me/57XXXXXXXXXX?text=Hola,%20quiero%20información" \
  --call-to-action contact_us

# 4. Ad
meta ads ad create ADSET_ID \
  --name "Ad nombre" \
  --creative-id CREATIVE_ID \
  --status active
```

### Campaña multi-creativo (test A/B)

```bash
# Misma campaña y adset, 3 creativos distintos
for CREATIVE_ID in ID_A ID_B ID_C; do
  meta ads ad create ADSET_ID \
    --name "Ad variante $CREATIVE_ID" \
    --creative-id $CREATIVE_ID \
    --status active
done

# Meta rotará y aprenderá cuál performa mejor
```

### Pausar todo rápido (emergencia)

```bash
# Pausar campaña entera (pausa todos los adsets y ads)
meta ads campaign update CAMPAIGN_ID --status paused

# Pausar solo un ad
meta ads ad update AD_ID --status paused
```

### Reporte semanal rápido

```bash
meta -o json ads insights get \
  --campaign-id CAMPAIGN_ID \
  --date-preset last_7d \
  --fields spend,impressions,clicks,ctr,cpc,reach \
  --time-increment daily | jq '.[] | {date_start, spend, clicks, ctr}'
```

---

## Limitaciones conocidas del CLI (v1.0.1)

- **Sin targeting avanzado**: No soporta edad, género, intereses, ni placements específicos desde la CLI — requiere API directa o Ads Manager.
- **`conversations` no funciona con URL simple**: Para Click to WhatsApp nativo, usar `outcome_traffic` + `link_clicks` con URL `wa.me`.
- **DCO puede fallar**: Con ciertas combinaciones de múltiples imágenes + múltiples CTAs. Crear creativos individuales como alternativa.
- **Sin audiencias personalizadas**: No hay soporte para Custom Audiences ni Lookalike Audiences.
- **Sin gestión de usuarios**: La asignación de usuarios a assets se hace en Business Settings.
- **Bulk imports**: No hay importación masiva de productos desde CSV/XML desde la CLI.

---

## Errores comunes y soluciones

| Error | Causa | Solución |
|---|---|---|
| `Invalid OAuth access token` | Token vencido, mal copiado o sin permisos | Regenerar en Business Settings → System Users |
| `Tried accessing nonexisting field` | Falta el prefijo `act_` en AD_ACCOUNT_ID | Usar `act_123456`, nunca solo `123456` |
| `Permissions error` al crear | System User sin "Manage Ad Account" | Business Settings → System Users → Add Assets → Ad Accounts |
| `command not found: meta` | `~/.local/bin` no está en PATH | `export PATH="$HOME/.local/bin:$PATH"` |
| `Se requiere un importe de puja` | El objetivo/cuenta requiere `--bid-amount` | Agregar `--bid-amount` al adset (en COP usar ≥ 500000) |
| `Una lista de activos solo puede tener un formato` | DCO con tipos incompatibles | Crear creativos individuales |
| `Comprueba el objetivo y tipo de contenido multimedia` | Creative incompatible con el objetivo del adset | Cambiar a `outcome_traffic` + `link_clicks` |
| Exit code 3 | Error de autenticación | `meta auth status` para diagnosticar |
| Exit code 4 | Error de API de Meta | Usar `meta --debug` para ver el error completo |

---

## Seguridad

- **Nunca** subir el `ACCESS_TOKEN` a Git — agregar `.env*` al `.gitignore`
- El token de System User da acceso completo al ad account: tratar como contraseña
- Si el token se filtra: Business Settings → System Users → **Reset Token** (el viejo deja de funcionar al instante)
- En servidores: guardar el token como secret de la plataforma (Vercel, GitHub Actions, etc.)

---

## Referencia rápida de comandos

```bash
# Auth
meta auth status

# Listar jerarquía completa
meta ads campaign list -l 25
meta ads adset list CAMPAIGN_ID
meta ads ad list ADSET_ID
meta ads creative list
meta ads page list

# Pausar / activar
meta ads campaign update CAMPAIGN_ID --status paused
meta ads campaign update CAMPAIGN_ID --status active
meta ads ad update AD_ID --status paused

# Ver métricas de hoy
meta ads insights get --date-preset today --fields spend,clicks,ctr,reach

# Ver cuál ad performa mejor esta semana
meta -o json ads insights get \
  --campaign-id CAMPAIGN_ID \
  --date-preset last_7d \
  --fields spend,clicks,ctr \
  | jq 'sort_by(.ctr) | reverse'

# Debug de cualquier comando
meta --debug ads campaign list

# Sin prompts (para scripts)
meta --no-input --force ads campaign delete CAMPAIGN_ID
```

---

## Documentación oficial

- CLI overview: https://developers.facebook.com/documentation/ads-commerce/ads-ai-connectors/ads-cli/ads-cli-overview
- PyPI: https://pypi.org/project/meta-ads/
- Blog launch: https://developers.facebook.com/blog/post/2026/04/29/introducing-ads-cli/
- Marketing API Insights: https://developers.facebook.com/docs/marketing-api/insights/
- Breakdowns: https://developers.facebook.com/docs/marketing-api/insights/breakdowns/
