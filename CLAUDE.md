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

## Troubleshooting
- **Pipeline Logs**: `docker logs orderloader -f`
- **DB Backups**: Found in `.data/pedidos/backups/`.
