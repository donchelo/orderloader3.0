# 📦 OrderLoader 3.0 (Google Cloud Deployed)

**OrderLoader** es una solución automatizada de nivel empresarial diseñada para la ingesta de pedidos en **SAP Business One**. Utiliza Inteligencia Artificial (Anthropic Claude) para transformar documentos PDF no estructurados en datos precisos listos para el ERP.

---

## 🚀 Despliegue Local (Docker)

El sistema corre completamente en local usando Docker.

```bash
docker compose up -d --build --remove-orphans
```

- **Dashboard**: [http://localhost:3000](http://localhost:3000)
- **Health check**: [http://localhost:3000/api/health](http://localhost:3000/api/health)

---

## ⚙️ Automatización y Pipeline

El sistema procesa pedidos automáticamente de lunes a domingo.

### ⏰ Horario de Ejecución (Cron)
- **Rango**: 6:00 AM - 10:00 PM (Hora Colombia, GMT-5).
- **Frecuencia**: Cada hora (en el minuto 0).
- **Mecanismo**: Cron job ejecutando `scripts/cron-pipeline.ts` vía `tsx`.

### 🔄 Lógica del Pipeline por Corrida
El pipeline procesa **un correo a la vez en loop** hasta vaciar la bandeja:
1. Descarga 1 correo → procesa pasos 1–5 → repite hasta bandeja vacía.
2. Al final de la corrida, ejecuta pasos 6–7 (notificación y archivado) **una sola vez** para todo el lote.
3. Si una corrida anterior fue interrumpida, recupera automáticamente los movimientos IMAP pendientes antes de comenzar.

### 📋 Pasos del Pipeline (step0 – step7)

| Step | Nombre       | Descripción |
|------|--------------|-------------|
| 0    | download     | Descarga correos desde IMAP y clasifica PDFs adjuntos |
| 1    | parse        | Extrae datos del PDF con Claude AI → JSON SAP B1 |
| 2    | validate     | Valida el JSON extraído contra el schema Zod |
| 3    | sap-catalog  | Verifica existencia de artículos en el catálogo SAP (AlternateCatNum) |
| 4    | upload       | Crea la Sales Order en SAP B1 (excluye artículos no catalogados) |
| 5    | reconcile    | Compara PDF vs Orden en SAP y registra discrepancias |
| 6    | notify       | Envía correo HTML de resumen a Tamaprint |
| 7    | archive      | Mueve el correo original en IMAP al destino final |

### 📂 Flujo de Carpetas (IMAP)
El pipeline monitoriza y organiza los correos directamente desde la bandeja de entrada:

1. **Origen**: `INBOX` — todos los correos entrantes.
2. **No reconocidos**: `A A SANDRA` — remitentes desconocidos o correos sin OC válida.
3. **Staging**: `A B INGRESADO` — pedidos en proceso durante el pipeline.
4. **Destino (Éxito)**: `A B INGRESADO` — el correo permanece aquí; sin diferencias ni artículos excluidos.
5. **Destino (Revisión)**: `A A REVISAR IA` — cuando hay errores de IA, validación, SAP o artículos excluidos.
6. **Destino (Extra)**: `A A SANDRA` — cuando el correo incluía archivos adicionales no aprobados.
7. **Notificaciones propias**: permanecen en `INBOX` — correos enviados por el propio OrderLoader.

---

## 🏢 Clientes Soportados

El sistema reconoce 14 clientes por NIT y palabras clave en los correos:
Comodin, Hermeco, Exito, Eurocorsett, IndustriasCory, EstudioModa, PinturasPrime, Manutex, ElGlobo, ServicioCompleto, ICVO, Produempak, Prointimo, Termimoda.

---

## 🛠️ Comandos útiles

```bash
# Levantar en producción
docker compose up -d --build --remove-orphans

# Ver logs del pipeline
docker logs orderloader -f

# Ejecutar pipeline manualmente
npx tsx scripts/cron-pipeline.ts

# Ver costos de IA
npx tsx scripts/calculate-costs.ts

# Verificar conexión IMAP
npx tsx scripts/check-imap.ts

# Probar extracción de un PDF manualmente
npx tsx scripts/test-parse-pdf.ts

# Verificar clientes nuevos (NITs no mapeados)
npx tsx scripts/verify-new-clients.ts

# Probar plantilla de email
npx tsx scripts/test-email-template.ts

# Calcular lead times de pedidos
npx tsx scripts/lead-times.ts

# Desarrollo local
npm run dev
```

---

## 📁 Estructura del Proyecto

```
/app              → Interfaz web y rutas API (Next.js App Router)
/lib/steps        → Lógica de los 8 pasos del pipeline (step0–step7)
/lib/config.ts    → Variables de entorno y mapeo NIT→CardCode
/lib/db.ts        → Gestión de base de datos SQLite
/lib/sap-client.ts → Cliente HTTP para SAP B1 Service Layer
/lib/schemas.ts   → Schema Zod para validación del JSON SAP
/lib/prompts      → Prompts de Claude por cliente
/scripts          → Utilidades de mantenimiento y diagnóstico
/.data            → Datos persistentes: DB, PDFs, backups (volumen Docker)
```

---

## 🔧 Variables de Entorno

Copia `.env.example` a `.env` y completa los valores:

| Variable              | Requerida | Descripción |
|-----------------------|-----------|-------------|
| `EMAIL_USER`          | ✅        | Usuario IMAP/SMTP |
| `EMAIL_PASS`          | ✅        | Contraseña IMAP/SMTP |
| `EMAIL_HOST`          | ✅        | Servidor IMAP (ej: `imap.tudominio.com`) |
| `EMAIL_PORT`          | —         | Puerto IMAP (default: `993`) |
| `EMAIL_SMTP_HOST`     | —         | Servidor SMTP (default: derivado de `EMAIL_HOST`) |
| `EMAIL_SMTP_PORT`     | —         | Puerto SMTP (default: `587`) |
| `NOTIFY_EMAIL`        | ✅        | Email donde llegan las notificaciones de pedidos |
| `NOTIFY_ALERTAS_EMAIL`| —         | Email para alertas de error (default: `NOTIFY_EMAIL`) |
| `SAP_B1_URL`          | ✅        | URL del Service Layer SAP B1 |
| `SAP_B1_USER`         | ✅        | Usuario SAP |
| `SAP_B1_PASS`         | ✅        | Contraseña SAP |
| `SAP_B1_COMPANY`      | ✅        | Nombre de la compañía SAP |
| `ANTHROPIC_API_KEY`   | ✅        | API Key de Anthropic Claude |
| `DATA_DIR`            | —         | Directorio de datos persistentes (default: `./.data`) |

---

## 🛡️ Notas de Seguridad
- El sistema realiza un **backup automático** de la base de datos antes de cada ejecución del pipeline.
- Las credenciales están en el archivo `.env` (no incluido en el repositorio).
- El dashboard opera **sin autenticación** dentro del VM (acceso por red).

---

Developed for **Tamaprint** | 2026
