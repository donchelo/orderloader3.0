import path from "path";
import { TAMAPRINT_RECEPTOR_KEYWORDS, FLEXO_RECEPTOR_KEYWORDS } from "./pdf-classify";

export type EmailProvider = "imap" | "microsoft";
export type Tenant = "tamaprint" | "flexoimpresos";

// Per-tenant static config — add new tenants here only
const TENANT_META: Record<Tenant, { displayName: string; receptorKeywords: string[]; cardCodePrefix: string }> = {
  tamaprint:     { displayName: "Tamaprint",     receptorKeywords: TAMAPRINT_RECEPTOR_KEYWORDS, cardCodePrefix: "CN" },
  flexoimpresos: { displayName: "Flexo Impresos", receptorKeywords: FLEXO_RECEPTOR_KEYWORDS,    cardCodePrefix: "C"  },
};

export interface Config {
  // Paths
  workspaceRoot: string;
  dbPath: string;
  pedidosRawDir: string;
  pedidosBackupsDir: string;
  pedidosReportsDir: string;
  pedidosIngresadosDir: string;

  // Email — proveedor y credenciales
  emailProvider: EmailProvider;
  emailUser: string;
  emailPass: string;
  emailHost: string;
  emailPort: number;
  /**
   * @deprecated Ya no se usa. El INBOX es la fuente de verdad: step0 procesa TODO
   * lo que esté en la bandeja sin importar el estado leído/no leído, para que los
   * clientes puedan reprocesar moviendo el correo de vuelta al INBOX.
   * Se mantiene el campo para no romper el parsing de PROCESS_UNREAD_ONLY en .env.
   */
  processUnreadOnly: boolean;

  // Microsoft Graph API (solo si emailProvider === "microsoft")
  msClientId: string;
  msTenantId: string;
  msClientSecret: string;

  // SMTP
  smtpHost: string;
  smtpPort: number;
  notifyEmail: string;
  notifyCcEmail: string;
  notifyAlertasEmail: string;

  // SAP B1
  sapUrl: string;
  sapUser: string;
  sapPass: string;
  sapCompany: string;

  // Tenant
  tenant: Tenant;
  tenantDisplayName: string;
  receptorKeywords: string[];
  stagingFolderName: string;
  manualReviewFolderName: string;
  cardCodePrefix: string;
}

const REQUIRED_ENV_BASE: [string, string][] = [
  // CRON_SECRET ya no se usa: el dashboard opera sin auth (sin passwords) en el VM.
  ["EMAIL_USER",        "buzón de correo (mailbox)"],
  ["NOTIFY_EMAIL",      "envío de notificaciones"],
  ["SAP_B1_URL",        "conexión SAP Business One"],
  ["SAP_B1_USER",       "conexión SAP Business One"],
  ["SAP_B1_PASS",       "conexión SAP Business One"],
  ["SAP_B1_COMPANY",    "conexión SAP Business One"],
  ["ANTHROPIC_API_KEY", "extracción AI de PDFs"],
];

const REQUIRED_ENV_IMAP: [string, string][] = [
  ["EMAIL_PASS",  "acceso IMAP/SMTP"],
  ["EMAIL_HOST",  "servidor IMAP"],
];

const REQUIRED_ENV_MICROSOFT: [string, string][] = [
  ["MS_CLIENT_ID",     "Microsoft Graph API"],
  ["MS_TENANT_ID",     "Microsoft Graph API"],
  ["MS_CLIENT_SECRET", "Microsoft Graph API"],
];

function validateEnv(): void {
  const isMicrosoft = process.env.EMAIL_PROVIDER === "microsoft";
  const providerEnv = isMicrosoft ? REQUIRED_ENV_MICROSOFT : REQUIRED_ENV_IMAP;
  const all = [...REQUIRED_ENV_BASE, ...providerEnv];
  const missing = all.filter(([key]) => !process.env[key]);
  if (missing.length === 0) return;
  const lines = missing.map(([key, desc]) => `  - ${key}  (${desc})`).join("\n");
  throw new Error(`OrderLoader: variables de entorno requeridas no configuradas:\n${lines}`);
}

let _config: Config | null = null;

export function getConfig(): Config {
  if (_config) return _config;
  validateEnv();

  // Workspace root = parent of this file's directory (orderloader/..)
  // In Next.js, process.cwd() is the project root
  const appRoot = process.cwd();
  // Usar DATA_DIR del entorno si existe, de lo contrario usar proyecto/.data/
  const workspaceRoot = process.env.DATA_DIR
    ? path.resolve(process.env.DATA_DIR)
    : path.resolve(appRoot, ".data");

  const emailUser = process.env.EMAIL_USER ?? "";
  const emailHost = process.env.EMAIL_HOST ?? "";
  const smtpHost =
    process.env.EMAIL_SMTP_HOST ||
    emailHost.replace("imap.", "smtp.") ||
    "";

  _config = {
    workspaceRoot,
    dbPath: path.join(workspaceRoot, "orderloader.db"),
    pedidosRawDir: path.join(workspaceRoot, "pedidos", "raw"),
    pedidosBackupsDir: path.join(workspaceRoot, "pedidos", "backups"),
    pedidosReportsDir: path.join(workspaceRoot, "pedidos", "reports"),
    pedidosIngresadosDir: path.join(workspaceRoot, "pedidos", "ingresados"),

    emailProvider: (process.env.EMAIL_PROVIDER ?? "imap") as EmailProvider,
    emailUser,
    emailPass: process.env.EMAIL_PASS ?? "",
    emailHost,
    emailPort: parseInt(process.env.EMAIL_PORT ?? "993"),
    processUnreadOnly: process.env.PROCESS_UNREAD_ONLY === "true",

    msClientId:     process.env.MS_CLIENT_ID     ?? "",
    msTenantId:     process.env.MS_TENANT_ID     ?? "",
    msClientSecret: process.env.MS_CLIENT_SECRET ?? "",

    smtpHost,
    smtpPort: parseInt(process.env.EMAIL_SMTP_PORT ?? "587"),
    notifyEmail: process.env.NOTIFY_EMAIL ?? emailUser,
    notifyCcEmail: process.env.NOTIFY_CC_EMAIL ?? "",
    notifyAlertasEmail:
      process.env.NOTIFY_ALERTAS_EMAIL ||
      process.env.NOTIFY_EMAIL ||
      emailUser,

    sapUrl: (process.env.SAP_B1_URL ?? "").replace(/\/$/, ""),
    sapUser: process.env.SAP_B1_USER ?? "",
    sapPass: process.env.SAP_B1_PASS ?? "",
    sapCompany: process.env.SAP_B1_COMPANY ?? "",

    tenant: (process.env.TENANT ?? "tamaprint") as Tenant,
    ...((): Pick<Config, "tenantDisplayName" | "receptorKeywords" | "cardCodePrefix"> => {
      const t = (process.env.TENANT ?? "tamaprint") as Tenant;
      const meta = TENANT_META[t] ?? TENANT_META["tamaprint"];
      return {
        tenantDisplayName: process.env.TENANT_DISPLAY_NAME ?? meta.displayName,
        receptorKeywords:  meta.receptorKeywords,
        cardCodePrefix:    process.env.CARD_CODE_PREFIX ?? meta.cardCodePrefix,
      };
    })(),
    stagingFolderName:      process.env.STAGING_FOLDER_NAME       ?? "A A REVISAR IA",
    manualReviewFolderName: process.env.MANUAL_REVIEW_FOLDER_NAME ?? "A A SANDRA",
  };

  return _config;
}
