# 📦 OrderLoader 3.0

**OrderLoader** es una solución automatizada de nivel empresarial diseñada para la ingesta de pedidos en **SAP Business One**. Utiliza Inteligencia Artificial (Anthropic Claude) para transformar documentos PDF no estructurados en datos precisos listos para el ERP.

---

## 🚀 Despliegue Local (Docker)

El sistema corre completamente en local usando Docker.

```bash
docker compose up -d --build
```

- **Dashboard**: [http://localhost:3000](http://localhost:3000)

---

## ⚙️ Automatización y Pipeline

El sistema procesa pedidos automáticamente de lunes a domingo.

### ⏰ Horario de Ejecución (Cron)
- **Rango**: 6:00 AM - 10:00 PM (Hora local).
- **Frecuencia**: Cada hora (en el minuto 0).
- **Mecanismo**: Cron job ejecutando `scripts/cron-pipeline.ts` vía `tsx`.

### 📂 Flujo de Carpetas (IMAP)
El pipeline monitoriza y organiza los correos en la cuenta configurada:
1. **Origen**: `A A INGRESAR IA` (Solo los correos en esta carpeta inician el pipeline).
2. **Destino (Éxito)**: `A A INGRESADO` (Cuando el pedido se crea en SAP sin observaciones).
3. **Destino (Revisión)**: `A A REVISAR IA` (Cuando hay errores de IA, validación o SAP).

---

## 🛠️ Comandos útiles

```bash
# Levantar en producción
docker compose up -d --build

# Ver logs del pipeline
docker logs orderloader -f

# Ejecutar pipeline manualmente
npx tsx scripts/cron-pipeline.ts

# Ver costos de IA
npx tsx scripts/calculate-costs.ts

# Desarrollo local
npm run dev
```

---

## 📁 Estructura del Proyecto
- `/app`: Interfaz de usuario y rutas API (Next.js).
- `/lib/steps`: Lógica individual de los 8 pasos del pipeline.
- `/scripts`: Utilidades de automatización y costos.
- `/lib/db.ts`: Gestión de base de datos local (SQLite).
- `.data/`: Carpeta persistente con la DB e historial de pedidos (montada como volumen Docker).

---

## 🛡️ Notas de Seguridad
- El sistema realiza un **backup automático** de la base de datos antes de cada ejecución del pipeline.
- Todas las credenciales están en el archivo `.env` (no incluido en el repositorio).

---

Developed for **Tamaprint** | 2026
