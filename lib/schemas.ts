import { z } from "zod";

/**
 * SAP B1 Document Line Schema
 */
export const DocumentLineSchema = z.object({
  SupplierCatNum: z.string().min(1, "SupplierCatNum es obligatorio"),
  Quantity: z.number().positive("La cantidad debe ser positiva"),
  UnitPrice: z.number().nonnegative("El precio unitario no puede ser negativo").optional(),
  DeliveryDate: z.string().regex(/^\d{8}$/, "La fecha de entrega debe tener formato YYYYMMDD").optional(),
  FreeText: z.string().optional(),
});

/**
 * SAP B1 Purchase Order Schema
 */
export const SapB1OrderSchema = z.object({
  DocType: z.literal("dDocument_Items"),
  NumAtCard: z.string().min(1, "NumAtCard (Orden de Compra) es obligatorio"),
  CardCode: z.string().startsWith("CN", "CardCode debe empezar por 'CN'"),
  DocDate: z.string().regex(/^\d{8}$/, "DocDate debe tener formato YYYYMMDD"),
  DocDueDate: z.string().regex(/^\d{8}$/, "DocDueDate debe tener formato YYYYMMDD"),
  TaxDate: z.string().regex(/^\d{8}$/, "TaxDate debe tener formato YYYYMMDD"),
  Comments: z.string().default(""),
  DocumentLines: z.array(DocumentLineSchema).min(1, "El pedido debe tener al menos una línea"),
});

export type DocumentLine = z.infer<typeof DocumentLineSchema>;
export type SapB1Order = z.infer<typeof SapB1OrderSchema>;
