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

**IMPORTANTE:** Nunca correr step 0 localmente — conecta al IMAP real y puede descargar correos del inbox productivo.

## Troubleshooting
- **Pipeline Logs**: `docker logs orderloader -f`
- **DB Backups**: Found in `.data/pedidos/backups/`.
