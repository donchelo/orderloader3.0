# Costo Real de la Digitación Manual de Pedidos

> Análisis de tiempo y costo laboral para empresas con SAP B1  
> Referencia para argumentación comercial y cálculo de ROI de OrderLoader  
> Actualizado mayo 2026 — base SMMLV 2026

---

## Desglose por Etapas del Proceso Manual

| # | Etapa | Tiempo estimado | Notas |
|---|---|---|---|
| 1 | Revisar bandeja de entrada y abrir el correo | 1–3 min | Depende de con qué frecuencia revisa el correo |
| 2 | Descargar el PDF adjunto y abrirlo | 1–2 min | |
| 3 | Leer e interpretar el PDF (identificar cliente, referencias, cantidades) | 2–5 min | Más si el PDF está escaneado o es ilegible |
| 4 | Abrir SAP B1 (si no está abierto) y navegar a Órdenes de Venta | 1–3 min | Si SAP ya está abierto puede ser 30 seg; arranque en frío puede ser 3–5 min |
| 5 | Buscar y seleccionar el cliente por NIT o nombre | 1–3 min | |
| 6 | Ingresar fecha de OC y fecha de entrega | 30 seg | |
| **7** | **Ingresar cada línea de pedido** | **2–5 min/referencia** | **Cuello de botella principal — ver nota abajo** |
| 8 | Verificar totales PDF vs. lo ingresado | 1–2 min | |
| 9 | Guardar y confirmar la orden en SAP | 30 seg | |
| 10 | Archivar el correo o marcarlo como procesado | 1 min | |

**Overhead fijo (pasos 1–6, 8–10):** ~9 min mínimo, ~20 min máximo.

**Nota sobre el paso 7:** El tiempo por referencia depende directamente de qué tan bien configurado esté el catálogo `AlternateCatNum` en SAP:

| Estado del catálogo | Tiempo por línea |
|---|---|
| AlternateCatNum configurado + autocomplete funciona | 30–90 seg |
| Catálogo incompleto — búsqueda manual necesaria | 2–5 min |
| Referencia no existe / ambigua — hay que escalar | 5–15 min |

En la mayoría de PYMEs colombianas el catálogo está parcialmente configurado, por lo que **2–5 min/referencia es el escenario más común**.

---

## Tiempo Total por Escenario

| Escenario | Referencias | Tiempo total | Condición |
|---|---|---|---|
| Pedido simple | 1–3 | **12–20 min** | Cliente conocido, PDF claro, referencias en catálogo |
| Pedido mediano | 5–10 | **25–50 min** | Operador con experiencia, formato familiar |
| Pedido complejo ~20 refs | 15–20 | **60–90 min** | Referencias difíciles de cruzar, PDF escaneado |
| Pedido complejo ~30 refs | 25–30 | **90–120 min** | Ídem — el techo real supera las 2 horas en casos extremos |
| Cliente nuevo | cualquiera | **+15–30 min extra** | Hay que crearlo en SAP primero |

**Promedio realista** para una empresa con pedidos mixtos: **30–40 minutos por pedido.**

> El promedio de 35 min es la referencia conservadora para calcular ROI con el prospecto. Si sus pedidos típicos tienen 3–5 referencias bien configuradas, el promedio se acerca a 20 min; si tienen 10–20 referencias o el catálogo es incompleto, se acerca a 50–60 min.

---

## Costo Laboral Mensual de la Digitación

Auxiliar de facturación en Colombia — costo total empresa (SMMLV 2026):

| Concepto | Valor |
|---|---|
| SMMLV 2026 | $1.558.742 COP |
| Auxilio de transporte 2026 | $219.000 COP |
| Carga prestacional + parafiscales | ~51,85% sobre salario base |
| **Costo total empresa (perfil SMMLV)** | **~$2.606.000 COP/mes** |
| Costo total empresa (perfil con experiencia SAP, 1,3–1,5 SMMLV) | ~$3.100.000 – $3.500.000 COP/mes |
| Horas efectivas trabajadas | ~160 h/mes |
| Costo por hora (perfil SMMLV) | ~$16.290 COP |
| Costo por minuto (perfil SMMLV) | ~$271 COP |

### Costo por Pedido según Escenario

| Escenario | Tiempo | Costo mín | Costo máx | Promedio |
|---|---|---|---|---|
| Simple (1–3 refs) | 12–20 min | $3.258 | $5.430 | **~$4.300** |
| Mediano (5–10 refs) | 25–50 min | $6.787 | $13.575 | **~$10.200** |
| Complejo ~20 refs | 60–90 min | $16.290 | $24.435 | **~$20.400** |
| Complejo ~30 refs | 90–120 min | $24.435 | $32.580 | **~$28.500** |

### Proyección por Volumen (35 min/pedido promedio)

| Volumen mensual | Costo laboral solo en digitación |
|---|---|
| 30 pedidos/mes | ~$285.000 COP/mes |
| 60 pedidos/mes | ~$570.000 COP/mes |
| 100 pedidos/mes | ~$950.000 COP/mes |
| 200 pedidos/mes | ~$1.900.000 COP/mes |

---

## Costos Ocultos (No Capturados en el Estimado Base)

El número anterior subestima el costo real. Los siguientes factores incrementan el costo sin aparecer en la nómina de forma visible:

| Costo oculto | Impacto estimado |
|---|---|
| **Correcciones de errores de digitación** | Una devolución o nota crédito puede costar 3–5x el tiempo de la digitación original |
| **Tiempo del supervisor** revisando antes de aprobar | +20–30% sobre el tiempo del operador |
| **Pedidos urgentes fuera de horario** | Una OC que llega a las 5:30 PM no se digita hasta el día siguiente; riesgo de incumplimiento |
| **Rotación del cargo** | Cada vez que el digitador renuncia, hay 2–4 semanas de inducción del reemplazo |
| **Costo de oportunidad** | La persona que digita no está haciendo gestión de cartera, atención al cliente ni análisis de ventas |

---

## Comparación: Manual vs. OrderLoader

| Métrica | Digitación manual | OrderLoader |
|---|---|---|
| Tiempo de intervención humana por pedido | 30–40 min promedio | < 2 min (revisión/aprobación) |
| Procesamiento total (incluyendo pipeline) | — | 2–5 min automático en segundo plano |
| Disponibilidad | Horario laboral | 6 AM – 10 PM, 7 días |
| Costo marginal por pedido adicional | $10.200 COP promedio | ~$100–$500 COP (costo API IA) |
| Escalabilidad | Lineal (más pedidos = más personal) | Constante (misma tarifa) |
| Tasa de error | Variable (fatiga, interrupciones) | Consistente (validación automática) |
| Trazabilidad | Ninguna (a menos que se documente manualmente) | Automática (conciliación PDF vs. SAP) |

---

## Argumento de ROI para el Prospecto

El cliente puede calcular su propio ROI en 2 minutos:

```
Pedidos al mes × minutos promedio × (salario mensual ÷ 160 h ÷ 60 min)
= Costo mensual actual de la digitación
```

**Ejemplo conservador — 50 pedidos/mes, salario $2.606.000 COP (SMMLV 2026), 35 min promedio:**
```
50 × 35 × ($2.606.000 ÷ 160 ÷ 60) = 50 × 35 × $271 = $474.250 COP/mes
```

Si OrderLoader cuesta $900.000 COP/mes, el retorno en ahorro laboral puro es de **~1,9 meses**.  
Sumando correcciones de errores, horas extra y costo de oportunidad, el ROI real es significativamente menor a 2 meses.

> Para una conversación de ventas conservadora se puede usar 25 min/pedido; el prospecto casi siempre descubrirá que su realidad es más lenta que eso, lo que refuerza el argumento después del cierre.

---

## Señales de Alarma en el Prospecto

Durante la conversación de ventas, estas respuestas confirman que el prospecto tiene el problema:

- *"Tenemos a Sandra que se encarga de eso"* → dependencia de persona clave
- *"Los lunes son un caos"* → acumulación en horas pico
- *"A veces se nos pasa algún pedido"* → riesgo de pérdida de correos
- *"Tuvimos un problema con un despacho equivocado"* → error de digitación con consecuencias
- *"Cuando ella se va de vacaciones nos complicamos"* → proceso no documentado
- *"Nuestros clientes usan referencias propias"* → catálogo AlternateCatNum incompleto → paso 7 tarda más
