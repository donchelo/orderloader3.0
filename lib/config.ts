import path from "path";

export interface Config {
  // Paths
  workspaceRoot: string;
  dbPath: string;
  pedidosRawDir: string;
  pedidosBackupsDir: string;
  pedidosReportsDir: string;
  pedidosIngresadosDir: string;

  // IMAP
  emailUser: string;
  emailPass: string;
  emailHost: string;
  emailPort: number;

  // SMTP
  smtpHost: string;
  smtpPort: number;
  notifyEmail: string;
  notifyAlertasEmail: string;

  // SAP B1
  sapUrl: string;
  sapUser: string;
  sapPass: string;
  sapCompany: string;
  sapPriceList: number;
  sapPriceTolerance: number;

  // NIT → CardCode mapping
  nitToCardCode: Record<string, string>;

  // Cliente → keywords para clasificar correos reenviados
  clientKeywords: Record<string, string[]>;
}

let _config: Config | null = null;

export function getConfig(): Config {
  if (_config) return _config;

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

    emailUser,
    emailPass: process.env.EMAIL_PASS ?? "",
    emailHost,
    emailPort: parseInt(process.env.EMAIL_PORT ?? "993"),

    smtpHost,
    smtpPort: parseInt(process.env.EMAIL_SMTP_PORT ?? "587"),
    notifyEmail: process.env.NOTIFY_EMAIL ?? emailUser,
    notifyAlertasEmail:
      process.env.NOTIFY_ALERTAS_EMAIL ||
      process.env.NOTIFY_EMAIL ||
      emailUser,

    sapUrl: (process.env.SAP_B1_URL ?? "").replace(/\/$/, ""),
    sapUser: process.env.SAP_B1_USER ?? "",
    sapPass: process.env.SAP_B1_PASS ?? "",
    sapCompany: process.env.SAP_B1_COMPANY ?? "",
    sapPriceList: parseInt(process.env.SAP_B1_PRICE_LIST ?? "1"),
    sapPriceTolerance: parseFloat(process.env.SAP_B1_PRICE_TOLERANCE ?? "2.0"),

    nitToCardCode: {
      "890924167": "CN890924167",
      "800069933": "CN800069933",
      "890900608": "CN890900608",
      "811032857": "CN811032857",
      "800131750": "CN800131750",
      "890926803": "CN890926803",
      "800194203": "CN800194203",
      "900426666": "CN900426666",
      "800227956": "CN800227956",
      "900690157": "CN900690157",
      "890932892": "CN890932892",
      "900445797": "CN900445797",
    },

    clientKeywords: {
      "Comodin":      ["gco", "comodin", "americanino", "800069933", "gco.com.co"],
      "Hermeco":      ["hermeco", "offcorss", "890924167", "offcorss.com"],
      "Exito":        ["exito", "grupo-exito", "890900608", "grupo-exito.com"],
      "Eurocorsett":  ["eurocorsett", "811032857", "eurocorsett.com"],
      "IndustriasCory": ["industrias cory", "800131750", "cory s.a.s"],
      "EstudioModa":  ["estudio de moda", "890926803"],
      "PinturasPrime": ["pinturas prime", "800194203", "pinturasprime.com"],
      "Manutex":      ["manutex", "comercializadora manutex", "900426666"],
      "ElGlobo":          ["el globo", "c.i. el globo", "800227956"],
      "ServicioCompleto": ["servicio completo", "900690157"],
      "ICVO":             ["icvo", "890932892", "icvo.com.co"],
      "Produempak":       ["produempak", "900445797"],
    },
  };

  return _config;
}
