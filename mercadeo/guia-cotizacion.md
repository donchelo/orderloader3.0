# Guía de Cotización — OrderLoader

> Referencia rápida para construir una propuesta en minutos.

---

## Paso 1 — Calificar el volumen del prospecto

Preguntar: **"¿Cuántos pedidos por OC reciben al mes y cuántas referencias tiene cada uno?"**

```
Líneas/mes = pedidos/mes × referencias promedio por pedido
```

| Si dice… | Líneas estimadas | Plan |
|---|---|---|
| "unos 20–30 pedidos simples" | ~60–100 líneas | **Esencial** |
| "50–80 pedidos, 3–5 referencias" | ~150–400 líneas | **Esencial / Estándar** |
| "100+ pedidos o clientes grandes" | 500+ líneas | **Estándar / Industrial** |
| "manejamos mucho volumen, varios canales" | 1.000+ líneas | **Industrial** |

> Si no sabe las líneas exactas: usar **3 líneas/pedido** como estimado conservador (dato real de producción).

---

## Paso 2 — Asignar plan

| Plan | Líneas/mes | Precio/línea | Mínimo mensual | Clientes config. |
|---|---|---|---|---|
| **Esencial** | hasta 233 | $1.490 COP | $150.000 | 3 |
| **Estándar** | hasta 610 | $920 COP | $250.000 | 8 |
| **Industrial** | ilimitadas | $570 COP | $400.000 | 15 |

Exceso de líneas: escala al precio del plan siguiente (no se corta el servicio).

**Fórmula:**
```
Costo mensual = MAX(mínimo del plan, líneas × precio/línea)
```

---

## Paso 3 — Calcular el setup

| Clientes a configurar | Setup (pago único) |
|---|---|
| 1 – 2 | $900.000 COP |
| 3 – 5 | $1.500.000 COP |
| 6 – 10 | $2.400.000 COP |
| 11 – 15 | $3.500.000 COP |
| Cliente adicional (sobre el plan) | $320.000 COP c/u |

> Un "cliente" = un proveedor con formato PDF propio que hay que configurar.  
> La conexión SAP B1 es única por empresa — no se cobra por cliente.

---

## Paso 4 — Calcular el ROI para el prospecto

**Costo manual del mercado (SMMLV 2026):**

```
Líneas/mes × 4,5 min × $271/min = costo mensual de digitación manual
```

> 4,5 min/línea es el promedio real (3.5 min cruce de referencia + overhead prorrateado).

| Líneas/mes | Costo manual | Costo OrderLoader | Ahorro neto |
|---|---|---|---|
| 100 | $122.000 | $150.000 *(mínimo)* | Empata — vender disponibilidad y errores |
| 233 | $284.000 | $150.000–$347.000 | $0–$134.000 |
| 250 | $305.000 | $250.000 *(mínimo Estándar)* | $55.000 |
| 500 | $609.000 | $460.000 | **$149.000/mes** |
| 1.000 | $1.218.000 | $570.000 | **$648.000/mes** |

> Si el ahorro es pequeño o negativo en lo laboral: el argumento es **disponibilidad 7 días**, **cero errores de digitación**, y **escalabilidad sin contratar**.

---

## Cotización rápida — ejemplos listos

### Prospecto pequeño (3.000 líneas/año, 100 clientes)
```
Líneas/mes: 250  →  Plan Esencial (excede límite 233, paga exceso a $920)
Costo mensual estimado: 233 × $1.490 + 17 × $920 = $347.010 COP
  o simplemente: ~$150.000–$350.000/mes según mes

Setup 3–5 clientes activos: $1.500.000 COP (único)
```

### Prospecto mediano (500 líneas/mes, 8 clientes)
```
Plan Estándar
Costo mensual: 500 × $920 = $460.000 COP
Setup 6–8 clientes: $2.400.000 COP (único)
Ahorro laboral: ~$149.000/mes → payback setup en 16 meses solo en ahorro
```

### Prospecto alto volumen (1.500 líneas/mes)
```
Plan Industrial
Costo mensual: 1.500 × $570 = $855.000 COP
Ahorro laboral: ~$1.100.000/mes → payback en < 1 mes
```

---

## Palancas de cierre

| Situación | Respuesta |
|---|---|
| "Es muy caro" | Calcular el costo manual exacto con sus números. Si el ROI no cierra en laboral, cambiar al argumento de errores + disponibilidad. |
| "Queremos un piloto" | 30 días sin cobro de líneas, pagando solo el setup. Asegura compromiso real. |
| "¿Pueden bajar el precio?" | El precio/línea no se negocia. El setup sí es flexible para clientes estratégicos. |
| "No tenemos SAP B1 con Service Layer" | Sin Service Layer no hay integración. Es requisito no negociable. |
| "¿Cuándo pueden empezar?" | Máx. 4 implementaciones nuevas por mes. Si hay cupo este mes, cerrarlo hoy. |

---

## Datos de respaldo (no citar, solo para saber)

| Métrica | Valor real |
|---|---|
| Costo API IA por línea | $18 COP |
| Costo infraestructura | $126.000 COP/mes fijo |
| Costo total sostenibilidad | ~$1.500 COP/línea (a escala media) |
| Promedio real líneas/pedido | 3,23 (datos mar–may 2026) |
| Tiempo pipeline por pedido | 2–5 min automático |
| Intervención humana | < 2 min (revisión/aprobación) |
