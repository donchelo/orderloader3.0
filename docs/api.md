# OrderLoader — API Endpoints

Todos los endpoints (excepto `/api/health`) requieren **HTTP Basic Auth**:
- Usuario: cualquiera
- Contraseña: valor de `CRON_SECRET` en `.env`

---

## GET /api/health

Verifica el estado del sistema. No requiere autenticación.

**Query params:**
- `check_sap=true` — hace un login real a SAP (más lento, usa en monitoreo)
- `check_deep=true` — verifica conectividad real de email y AI (más lento)

**Response 200 — sistema saludable:**
```json
{
  "ok": true,
  "version": "0.1.0",
  "tenant": "tamaprint",
  "db": { "status": "ok", "pedidos": 142 },
  "pipeline": {
    "last_run": "2025-01-15T10:30:00.000Z",
    "hours_ago": 1.5,
    "missed_cron": false
  },
  "sap": {
    "status": "configured",
    "configured": true,
    "url": "https://sap-server:50000/b1s/v2",
    "error": null
  },
  "email": {
    "status": "configured",
    "configured": true,
    "provider": "imap",
    "user": "pedidos@empresa.com"
  },
  "ai": {
    "status": "configured",
    "configured": true
  }
}
```

**Response 503 — sistema degradado** (misma estructura, `ok: false`, `missed_cron: true` si el cron no corrió en >25h).

**Valores de `status`:**
- `configured` — variable presente pero no testeada en vivo
- `ok` — verificado en vivo (solo con `check_sap=true` o `check_deep=true`)
- `missing_vars` — variable de entorno faltante
- `error: <mensaje>` — fallo en la verificación en vivo

---

## GET /api/pipeline/run

Retorna si el pipeline está corriendo actualmente.

**Auth:** Basic Auth requerido en producción.

**Response:**
```json
{ "running": false }
```

---

## POST /api/pipeline/run

Dispara el pipeline. Retorna un stream SSE con el progreso en tiempo real.

**Auth:** Basic Auth requerido. Rate limit: 1 trigger cada 5 minutos por IP (429 si se supera).

**Body (opcional):**
```json
{
  "fromStep": 0,
  "toStep": 7,
  "onlyStep": null
}
```
- Omitir body → corre el pipeline completo (steps 0–7)
- `fromStep`/`toStep` → rango de steps (ej. `{"fromStep": 3, "toStep": 4}`)
- `onlyStep` → solo un step específico

**Response: `text/event-stream`**

Cada evento tiene formato `data: <JSON>\n\n`:

```
data: {"type":"step","result":{"step":0,"name":"download","procesados":1,"errores":0,"saltados":0,"detalles":["✓ Comodin/2025-01-15 — 1 PDF procesado"],"duracionMs":1243}}

data: {"type":"step","result":{"step":1,"name":"parse","procesados":1,"errores":0,"saltados":0,"detalles":["✓ OC OC-2025-001 → PARSED (5 items)"],"duracionMs":8320}}

data: {"type":"done"}
```

**Tipos de evento:**
- `step` — resultado de un step completado
- `done` — pipeline terminó exitosamente
- `error` — error inesperado en el pipeline

**Response 409** si el pipeline ya está corriendo:
```json
{ "error": "Pipeline ya está en ejecución" }
```

**Response 429** si se supera el rate limit:
```
Rate limit: espera 243s antes de volver a disparar el pipeline
```
Header: `Retry-After: 243`

---

## POST /api/pipeline/stop

Solicita detener el pipeline después del correo actual (no es inmediato).

**Auth:** Basic Auth requerido.

**Response:**
```json
{ "ok": true, "message": "Stop solicitado" }
```

---

## Ejemplos de uso

```bash
# Health check
curl http://localhost:3000/api/health

# Health check con verificación SAP
curl "http://localhost:3000/api/health?check_sap=true"

# Disparar pipeline completo
curl -X POST -u user:$CRON_SECRET http://localhost:3000/api/pipeline/run

# Disparar solo step 4 (upload a SAP)
curl -X POST -u user:$CRON_SECRET \
  -H "Content-Type: application/json" \
  -d '{"onlyStep": 4}' \
  http://localhost:3000/api/pipeline/run

# Ver progreso en tiempo real
curl -N -X POST -u user:$CRON_SECRET \
  -H "Content-Type: application/json" \
  -d '{}' \
  http://localhost:3000/api/pipeline/run

# Detener pipeline
curl -X POST -u user:$CRON_SECRET http://localhost:3000/api/pipeline/stop

# Verificar si está corriendo
curl -u user:$CRON_SECRET http://localhost:3000/api/pipeline/run
```
