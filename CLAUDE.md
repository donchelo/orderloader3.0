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

## Troubleshooting
- **Pipeline Logs**: `docker logs orderloader -f`
- **DB Backups**: Found in `.data/pedidos/backups/`.
