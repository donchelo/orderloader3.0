# OrderLoader 3.0 - Developer Guide

## Core Commands
- **Dev Server**: `npm run dev`
- **Build**: `npm run build`
- **Prod Mode (Docker)**: `docker compose up -d --build`
- **Manual Pipeline**: `npx tsx scripts/cron-pipeline.ts`
- **Calculate AI Costs**: `npx tsx scripts/calculate-costs.ts`

## Coding Standards
- **Framework**: Next.js 15+ (App Router)
- **Database**: SQLite with `better-sqlite3`.
- **Logic**: Sequential pipeline in `lib/steps`.
- **Naming**: Spanish for business logic (pedidos, maestro, detalle), English for technical components.

## Multi-Tenant
El sistema corre como **instancias separadas por cliente**, una por VM/container. La variable `TENANT` controla el comportamiento.

| Cliente | `TENANT` | Email | Env file |
|---|---|---|---|
| TamaPrint | `tamaprint` (default) | IMAP / one.com | `.env` |
| FlexoImpresos | `flexoimpresos` | Microsoft Graph (Office 365) | `.env.flexoimpresos` |

Para deployar FlexoImpresos, copiar `.env.flexoimpresos` como `.env` en la VM correspondiente antes de correr el build.

No hay `tenant_id` en la BD — cada instancia tiene su propia base de datos aislada en `.data/`.

## Deploy
Siempre que termines de hacer cambios, ejecuta el deploy en Docker:
```bash
docker compose up -d --build
```

## Desarrollo Local
Antes de probar cambios, sincroniza la BD desde la VM:
```bash
npm run pull-db
```
Configura `VM_HOST=user@ip` y opcionalmente `VM_PATH=~/ruta/.data` en `.env.local` (no se commitea).

**IMPORTANTE:** Nunca correr step 0 localmente — en cualquier tenant conecta al inbox real de producción (IMAP o Microsoft Graph) y puede descargar correos activos.

## Rotación de Secrets

### CRON_SECRET (HTTP Basic Auth)
Protege todos los endpoints excepto `/api/health`. Si se compromete, rotar así:

```bash
# 1. Generar nuevo secret
openssl rand -base64 32

# 2. Actualizar en la VM
#    Editar .env en ~/orderLoader/ con el nuevo valor

# 3. Actualizar en GitHub Secrets (Settings → Secrets → CRON_SECRET)
#    Si el cron de GitHub Actions usa este secret en el script de deploy

# 4. Redeploy
docker compose up -d --build

# 5. Verificar que el health check siga respondiendo
curl http://localhost:3000/api/health
```

### ANTHROPIC_API_KEY
Rotar en https://console.anthropic.com/ → API Keys. Actualizar `.env` y redeploy.

### SAP B1 Credentials
Coordinar con el administrador SAP. Actualizar `SAP_B1_USER`, `SAP_B1_PASS` en `.env` y redeploy.

## Troubleshooting
- **Pipeline Logs**: `docker logs orderloader -f`
- **DB Backups**: Found in `.data/pedidos/backups/`.
- **Runbook completo**: Ver `docs/runbook.md`
