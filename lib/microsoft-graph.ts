/**
 * Cliente liviano para Microsoft Graph API.
 * Usa fetch nativo (Node 18+) — sin dependencias adicionales.
 * Autenticación: Client Credentials Flow (OAuth2, sin usuario interactivo).
 */

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

interface TokenCache {
  token: string;
  expiresAt: number;
}

let _tokenCache: TokenCache | null = null;

export async function getAccessToken(
  tenantId: string,
  clientId: string,
  clientSecret: string
): Promise<string> {
  const now = Date.now();
  if (_tokenCache && _tokenCache.expiresAt > now + 5 * 60 * 1000) {
    return _tokenCache.token;
  }
  const res = await fetch(
    `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/token`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "client_credentials",
        client_id: clientId,
        client_secret: clientSecret,
        scope: "https://graph.microsoft.com/.default",
      }),
    }
  );
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Graph token error ${res.status}: ${text.slice(0, 300)}`);
  }
  const data = (await res.json()) as { access_token: string; expires_in: number };
  _tokenCache = { token: data.access_token, expiresAt: now + data.expires_in * 1000 };
  return data.access_token;
}

async function gGet(token: string, path: string): Promise<unknown> {
  const res = await fetch(`${GRAPH_BASE}${path}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Graph GET ${path}: ${res.status} ${text.slice(0, 300)}`);
  }
  return res.json();
}

async function gPost(token: string, path: string, body: unknown): Promise<unknown> {
  const res = await fetch(`${GRAPH_BASE}${path}`, {
    method: "POST",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Graph POST ${path}: ${res.status} ${text.slice(0, 300)}`);
  }
  if (res.status === 204) return null;
  return res.json();
}

async function gPatch(token: string, path: string, body: unknown): Promise<void> {
  const res = await fetch(`${GRAPH_BASE}${path}`, {
    method: "PATCH",
    headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Graph PATCH ${path}: ${res.status} ${text.slice(0, 300)}`);
  }
}

export interface GraphMessage {
  id: string;
  internetMessageId: string;
  subject: string;
  from: { emailAddress: { address: string; name?: string } };
  receivedDateTime: string;
  isRead: boolean;
  body?: { contentType: string; content: string };
}

export interface GraphFileAttachment {
  "@odata.type": "#microsoft.graph.fileAttachment";
  id: string;
  name: string;
  contentType: string;
  contentBytes: string; // base64
}

// Cache de IDs de carpetas: "email::displayName" → id
const _folderCache = new Map<string, string>();

/**
 * Devuelve el ID de una subcarpeta de Inbox, creándola si no existe.
 * Las carpetas de OrderLoader viven bajo Inbox, como en IMAP (INBOX.X).
 */
export async function getOrCreateInboxChildFolder(
  token: string,
  userEmail: string,
  displayName: string
): Promise<string> {
  const key = `${userEmail}::${displayName}`;
  if (_folderCache.has(key)) return _folderCache.get(key)!;

  const data = (await gGet(
    token,
    `/users/${encodeURIComponent(userEmail)}/mailFolders/Inbox/childFolders?$select=id,displayName&$top=50`
  )) as { value: Array<{ id: string; displayName: string }> };

  for (const f of data.value) {
    _folderCache.set(`${userEmail}::${f.displayName}`, f.id);
    if (f.displayName === displayName) return f.id;
  }

  // Crear si no existe
  const created = (await gPost(
    token,
    `/users/${encodeURIComponent(userEmail)}/mailFolders/Inbox/childFolders`,
    { displayName }
  )) as { id: string; displayName: string };
  _folderCache.set(key, created.id);
  return created.id;
}

/** Lista mensajes de Inbox, opcionalmente solo los no leídos. */
export async function listInboxMessages(
  token: string,
  userEmail: string,
  unreadOnly: boolean
): Promise<GraphMessage[]> {
  const filter = unreadOnly ? "&$filter=isRead eq false" : "";
  const data = (await gGet(
    token,
    `/users/${encodeURIComponent(userEmail)}/mailFolders/Inbox/messages?$select=id,internetMessageId,subject,from,receivedDateTime,isRead&$top=50${filter}`
  )) as { value: GraphMessage[] };
  return data.value;
}

/** Obtiene el mensaje completo con adjuntos expandidos. */
export async function getMessageWithAttachments(
  token: string,
  userEmail: string,
  messageId: string
): Promise<GraphMessage & { attachments: GraphFileAttachment[] }> {
  return (await gGet(
    token,
    `/users/${encodeURIComponent(userEmail)}/messages/${messageId}?$expand=attachments`
  )) as GraphMessage & { attachments: GraphFileAttachment[] };
}

/** Mueve un mensaje a otra carpeta. Devuelve el mensaje con su nuevo ID. */
export async function moveMessage(
  token: string,
  userEmail: string,
  messageId: string,
  destinationFolderId: string
): Promise<GraphMessage> {
  return (await gPost(
    token,
    `/users/${encodeURIComponent(userEmail)}/messages/${messageId}/move`,
    { destinationId: destinationFolderId }
  )) as GraphMessage;
}

/** Marca un mensaje como leído. */
export async function markAsRead(
  token: string,
  userEmail: string,
  messageId: string
): Promise<void> {
  await gPatch(token, `/users/${encodeURIComponent(userEmail)}/messages/${messageId}`, {
    isRead: true,
  });
}

/** Busca un mensaje en una carpeta por su internetMessageId (RFC 5322 Message-ID). */
export async function findMessageInFolder(
  token: string,
  userEmail: string,
  folderId: string,
  internetMessageId: string
): Promise<GraphMessage | null> {
  const clean = internetMessageId.replace(/'/g, "''"); // escape single quotes para OData
  const data = (await gGet(
    token,
    `/users/${encodeURIComponent(userEmail)}/mailFolders/${folderId}/messages?$filter=internetMessageId eq '${encodeURIComponent(clean)}'&$select=id,internetMessageId,subject&$top=1`
  )) as { value: GraphMessage[] };
  return data.value[0] ?? null;
}

/** Busca un mensaje en Inbox por internetMessageId. */
export async function findMessageInInbox(
  token: string,
  userEmail: string,
  internetMessageId: string
): Promise<GraphMessage | null> {
  const clean = internetMessageId.replace(/'/g, "''");
  const data = (await gGet(
    token,
    `/users/${encodeURIComponent(userEmail)}/mailFolders/Inbox/messages?$filter=internetMessageId eq '${encodeURIComponent(clean)}'&$select=id,internetMessageId,subject&$top=1`
  )) as { value: GraphMessage[] };
  return data.value[0] ?? null;
}

/**
 * Envía un correo usando la API Graph (reemplaza nodemailer para Microsoft).
 * Soporta adjuntos inline (CID) para logos embebidos en HTML.
 */
export async function sendMailGraph(
  token: string,
  fromEmail: string,
  to: string,
  cc: string | undefined,
  subject: string,
  html: string,
  inlineAttachments: Array<{
    name: string;
    contentType: string;
    contentBytes: string; // base64
    contentId: string;
  }> = []
): Promise<void> {
  await gPost(token, `/users/${encodeURIComponent(fromEmail)}/sendMail`, {
    message: {
      subject,
      body: { contentType: "HTML", content: html },
      toRecipients: [{ emailAddress: { address: to } }],
      ...(cc ? { ccRecipients: [{ emailAddress: { address: cc } }] } : {}),
      attachments: inlineAttachments.map((a) => ({
        "@odata.type": "#microsoft.graph.fileAttachment",
        name: a.name,
        contentType: a.contentType,
        contentBytes: a.contentBytes,
        contentId: a.contentId,
        isInline: true,
      })),
    },
  });
}
