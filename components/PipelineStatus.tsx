"use client";

import { Badge, type BadgeProps } from "@/design-system";

const STATUS_MAP: Record<string, { label: string; variant: BadgeProps["variant"] }> = {
  NUEVO:            { label: "Nuevo",           variant: "outline"  },
  PARSED:           { label: "Parseado",         variant: "muted"    },
  PARSE_VALIDO:     { label: "Parse OK",         variant: "muted"    },
  SAP_NUEVO:        { label: "SAP: Nuevo",       variant: "blue"     },
  SAP_VERIFICADO:   { label: "SAP: Verificado",  variant: "blue"     },
  ITEMS_OK:         { label: "Ítems OK",         variant: "blue"     },
  SAP_MONTADO:      { label: "SAP Subido",       variant: "blue"     },
  VALIDADO:         { label: "Validado",         variant: "success"  },
  CERRADO:          { label: "Cerrado",          variant: "success"  },
  ERROR_PARSE:      { label: "Error Parse",      variant: "danger"   },
  ERROR_DUPLICADO:  { label: "Duplicado",        variant: "danger"   },
  ERROR_ITEMS:      { label: "Error Ítems",      variant: "danger"   },
  ERROR_SAP:        { label: "Error SAP",        variant: "danger"   },
  ERROR_VALIDACION: { label: "Error Validación", variant: "danger"   },
};

export default function PipelineStatus({ estado }: { estado: string }) {
  const cfg = STATUS_MAP[estado] ?? { label: estado, variant: "muted" as const };
  return <Badge variant={cfg.variant}>{cfg.label}</Badge>;
}
