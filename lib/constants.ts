/** Estados del ciclo de vida de un pedido en pedidos_maestro.estado */
export const OrderStatus = {
  NUEVO:            "NUEVO",
  PARSED:           "PARSED",
  PARSE_VALIDO:     "PARSE_VALIDO",
  ERROR_PARSE:      "ERROR_PARSE",
  ERROR_DUPLICADO:  "ERROR_DUPLICADO",
  CATALOG_OK:       "CATALOG_OK",
  ERROR_CATALOG:    "ERROR_CATALOG",
  SAP_NUEVO:        "SAP_NUEVO",       // backward-compat
  SAP_MONTADO:      "SAP_MONTADO",
  ERROR_ITEMS:      "ERROR_ITEMS",
  ERROR_SAP:        "ERROR_SAP",
} as const;

export type OrderStatusValue = (typeof OrderStatus)[keyof typeof OrderStatus];

/** Estados terminales que no necesitan más procesamiento */
export const TERMINAL_STATES: OrderStatusValue[] = [
  OrderStatus.SAP_MONTADO,
  OrderStatus.ERROR_DUPLICADO,
];

/** Estados de error que generan alertas de alta tasa */
export const ERROR_STATES: OrderStatusValue[] = [
  OrderStatus.ERROR_PARSE,
  OrderStatus.ERROR_DUPLICADO,
  OrderStatus.ERROR_CATALOG,
  OrderStatus.ERROR_ITEMS,
  OrderStatus.ERROR_SAP,
];
